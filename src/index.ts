/**
 * Gemini TTS on Cloudflare Workers.
 *
 * POST /api/tts  { text, voice?, model?, temperature? }  ->  audio/wav
 * GET  /api/voices                                        ->  { voices, models }
 * Everything else is served from ./public via the ASSETS binding.
 *
 * This is a port of the google-genai Python sample: the Worker calls the
 * Gemini REST API with responseModalities=["AUDIO"], receives raw PCM
 * (audio/L16;rate=24000) as base64, wraps it in a WAV header and returns it.
 */

export interface Env {
  GEMINI_API_KEY: string;
  ASSETS: Fetcher;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const MODELS = [
  "gemini-2.5-pro-preview-tts",
  "gemini-2.5-flash-preview-tts",
] as const;

export const VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
] as const;

const DEFAULT_MODEL = MODELS[0];
const DEFAULT_VOICE = "Zephyr";
const MAX_TEXT_LENGTH = 20_000;

interface TtsRequest {
  text?: unknown;
  voice?: unknown;
  model?: unknown;
  temperature?: unknown;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/tts") {
      if (request.method !== "POST") {
        return json({ error: "Method Not Allowed" }, 405, { Allow: "POST" });
      }
      return handleTts(request, env);
    }

    if (url.pathname === "/api/voices") {
      return json({ voices: VOICES, models: MODELS, defaultVoice: DEFAULT_VOICE, defaultModel: DEFAULT_MODEL });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleTts(request: Request, env: Env): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    return json({ error: "GEMINI_API_KEY is not configured on the Worker." }, 500);
  }

  let body: TtsRequest;
  try {
    body = (await request.json()) as TtsRequest;
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "`text` is required." }, 400);
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ error: `\`text\` is too long (max ${MAX_TEXT_LENGTH} characters).` }, 400);
  }

  const voice = typeof body.voice === "string" && (VOICES as readonly string[]).includes(body.voice)
    ? body.voice
    : DEFAULT_VOICE;
  const model = typeof body.model === "string" && (MODELS as readonly string[]).includes(body.model)
    ? body.model
    : DEFAULT_MODEL;
  const temperature = typeof body.temperature === "number" && body.temperature >= 0 && body.temperature <= 2
    ? body.temperature
    : 1;

  const geminiRes = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        temperature,
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
    }),
  });

  let data: GeminiResponse;
  try {
    data = (await geminiRes.json()) as GeminiResponse;
  } catch {
    return json({ error: `Gemini API returned a non-JSON response (HTTP ${geminiRes.status}).` }, 502);
  }

  if (!geminiRes.ok) {
    const message = data.error?.message ?? `HTTP ${geminiRes.status}`;
    return json({ error: `Gemini API error: ${message}` }, geminiRes.status >= 400 && geminiRes.status < 500 ? geminiRes.status : 502);
  }

  if (data.promptFeedback?.blockReason) {
    return json({ error: `Request was blocked: ${data.promptFeedback.blockReason}` }, 422);
  }

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const audioParts = parts.filter((p) => p.inlineData?.data);
  if (audioParts.length === 0) {
    const textOut = parts.map((p) => p.text).filter(Boolean).join("\n");
    const reason = data.candidates?.[0]?.finishReason;
    return json(
      { error: "Gemini returned no audio.", finishReason: reason, text: textOut || undefined },
      502,
    );
  }

  const mimeType = audioParts[0].inlineData!.mimeType;
  const pcm = concat(audioParts.map((p) => base64ToBytes(p.inlineData!.data)));
  const isWav = /^audio\/(wav|x-wav|wave)/i.test(mimeType);
  const wav = isWav ? pcm : toWav(pcm, mimeType);

  const filename = `tts-${voice.toLowerCase()}-${timestamp()}.wav`;
  return new Response(wav, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(wav.byteLength),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Gemini-Model": model,
      "X-Gemini-Voice": voice,
      "X-Source-Mime-Type": mimeType,
    },
  });
}

/** Parses "audio/L16;codec=pcm;rate=24000" -> { bitsPerSample: 16, rate: 24000 }. */
export function parseAudioMimeType(mimeType: string): { bitsPerSample: number; rate: number } {
  let bitsPerSample = 16;
  let rate = 24000;
  for (const raw of mimeType.split(";")) {
    const param = raw.trim();
    if (param.toLowerCase().startsWith("rate=")) {
      const n = parseInt(param.slice(5), 10);
      if (Number.isFinite(n) && n > 0) rate = n;
    } else if (/^audio\/L\d+$/i.test(param)) {
      const n = parseInt(param.slice(7), 10);
      if (Number.isFinite(n) && n > 0) bitsPerSample = n;
    }
  }
  return { bitsPerSample, rate };
}

/** Prepends a 44-byte RIFF/WAVE header (mono PCM) to raw audio samples. */
export function toWav(audio: Uint8Array, mimeType: string): Uint8Array {
  const { bitsPerSample, rate } = parseAudioMimeType(mimeType);
  const numChannels = 1;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = rate * blockAlign;
  const dataSize = audio.byteLength;

  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  writeAscii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  writeAscii(v, 8, "WAVE");
  writeAscii(v, 12, "fmt ");
  v.setUint32(16, 16, true); // Subchunk1Size (PCM)
  v.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  v.setUint16(22, numChannels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  writeAscii(v, 36, "data");
  v.setUint32(40, dataSize, true);

  const out = new Uint8Array(44 + dataSize);
  out.set(new Uint8Array(header), 0);
  out.set(audio, 44);
  return out;
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
