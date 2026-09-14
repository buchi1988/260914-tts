/**
 * Gemini TTS on Cloudflare Workers.
 *
 * POST /api/tts  { text, voice?, model?, temperature? }  ->  audio/wav (streamed)
 * GET  /api/voices                                        ->  { voices, models }
 * Everything else is served from ./public via the ASSETS binding.
 *
 * This is a port of the google-genai Python sample. The Worker calls the
 * Gemini streaming REST API (streamGenerateContent?alt=sse) with
 * responseModalities=["AUDIO"], receives raw PCM (audio/L16;rate=24000)
 * chunks as base64, and streams them back to the client behind a WAV header.
 *
 * Streaming on both hops matters: Cloudflare cuts a request with HTTP 524
 * when the origin sends no bytes for ~100 s, and a long transcript takes
 * longer than that to synthesize in one shot. With SSE the first audio bytes
 * arrive within seconds, so neither hop idles.
 *
 * Because the total length is unknown when the header is written, the RIFF
 * and data size fields are set to 0xFFFFFFFF ("unknown length", which most
 * players accept). The browser client patches them once the download ends.
 */

export interface Env {
  GEMINI_API_KEY: string;
  /** Optional override, mainly for tests. Defaults to the public Gemini API. */
  GEMINI_API_BASE?: string;
  ASSETS: Fetcher;
}

const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const MODELS = [
  "gemini-2.5-pro-preview-tts",
  "gemini-2.5-flash-preview-tts",
] as const;

const VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
] as const;

const DEFAULT_MODEL = MODELS[0];
const DEFAULT_VOICE = "Zephyr";
const MAX_TEXT_LENGTH = 20_000;
const UNKNOWN_SIZE = 0xffffffff;

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

interface GeminiEvent {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/tts") {
      if (request.method !== "POST") {
        return json({ error: "Method Not Allowed" }, 405, { Allow: "POST" });
      }
      return handleTts(request, env, ctx);
    }

    if (url.pathname === "/api/voices") {
      return json({ voices: VOICES, models: MODELS, defaultVoice: DEFAULT_VOICE, defaultModel: DEFAULT_MODEL });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleTts(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  const base = (env.GEMINI_API_BASE || DEFAULT_GEMINI_BASE).replace(/\/+$/, "");
  const upstream = await fetch(`${base}/models/${model}:streamGenerateContent?alt=sse`, {
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

  if (!upstream.ok) {
    const message = await upstreamErrorMessage(upstream);
    const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
    return json({ error: `Gemini API error: ${message}` }, status);
  }
  if (!upstream.body) {
    return json({ error: "Gemini API returned an empty response." }, 502);
  }

  // Read events until the first audio chunk so we know the sample format
  // before committing to response headers.
  const events = parseSse(upstream.body);
  const pending: Uint8Array[] = [];
  const textParts: string[] = [];
  let mimeType: string | undefined;
  let finishReason: string | undefined;

  while (!mimeType) {
    const { value: ev, done } = await events.next();
    if (done) break;
    if (ev.error?.message) {
      return json({ error: `Gemini API error: ${ev.error.message}` }, 502);
    }
    if (ev.promptFeedback?.blockReason) {
      return json({ error: `Request was blocked: ${ev.promptFeedback.blockReason}` }, 422);
    }
    finishReason = ev.candidates?.[0]?.finishReason ?? finishReason;
    for (const p of ev.candidates?.[0]?.content?.parts ?? []) {
      if (p.inlineData?.data) {
        mimeType ??= p.inlineData.mimeType;
        pending.push(base64ToBytes(p.inlineData.data));
      } else if (p.text) {
        textParts.push(p.text);
      }
    }
  }

  if (!mimeType) {
    return json(
      { error: "Gemini returned no audio.", finishReason, text: textParts.join("\n") || undefined },
      502,
    );
  }

  const { bitsPerSample, rate } = parseAudioMimeType(mimeType);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  const pump = async () => {
    const writer = writable.getWriter();
    try {
      await writer.write(wavHeader(UNKNOWN_SIZE, bitsPerSample, rate));
      for (const chunk of pending) await writer.write(chunk);
      for (;;) {
        const { value: ev, done } = await events.next();
        if (done) break;
        if (ev.error?.message) throw new Error(`Gemini API error mid-stream: ${ev.error.message}`);
        for (const p of ev.candidates?.[0]?.content?.parts ?? []) {
          if (p.inlineData?.data) await writer.write(base64ToBytes(p.inlineData.data));
        }
      }
      await writer.close();
    } catch (err) {
      console.error("tts stream failed", err);
      await writer.abort(err).catch(() => {});
    }
  };
  ctx.waitUntil(pump());

  const filename = `tts-${voice.toLowerCase()}-${timestamp()}.wav`;
  return new Response(readable, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Sample-Rate": String(rate),
      "X-Bits-Per-Sample": String(bitsPerSample),
      "X-Gemini-Model": model,
      "X-Gemini-Voice": voice,
      "X-Source-Mime-Type": mimeType,
    },
  });
}

async function upstreamErrorMessage(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw);
    const err = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    if (err?.message) return String(err.message);
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
}

/** Yields one parsed JSON object per `data:` line of a text/event-stream body. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<GeminiEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseLine = (line: string): GeminiEvent | undefined => {
    if (!line.startsWith("data:")) return undefined;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return undefined;
    try {
      return JSON.parse(payload) as GeminiEvent;
    } catch {
      console.warn("skipping malformed SSE line", payload.slice(0, 120));
      return undefined;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const ev = parseLine(buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
        if (ev) yield ev;
      }
      if (done) {
        const ev = parseLine(buffer.replace(/\r$/, ""));
        if (ev) yield ev;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
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

/**
 * Builds a 44-byte RIFF/WAVE header for mono PCM. Pass UNKNOWN_SIZE as
 * dataSize when streaming; both size fields then read 0xFFFFFFFF.
 */
export function wavHeader(dataSize: number, bitsPerSample: number, rate: number): Uint8Array {
  const numChannels = 1;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = rate * blockAlign;
  const riffSize = dataSize === UNKNOWN_SIZE ? UNKNOWN_SIZE : 36 + dataSize;

  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  writeAscii(v, 0, "RIFF");
  v.setUint32(4, riffSize, true);
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
  return header;
}

/** Prepends a complete WAV header (known length) to raw PCM samples. */
export function toWav(audio: Uint8Array, mimeType: string): Uint8Array {
  const { bitsPerSample, rate } = parseAudioMimeType(mimeType);
  const out = new Uint8Array(44 + audio.byteLength);
  out.set(wavHeader(audio.byteLength, bitsPerSample, rate), 0);
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

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
