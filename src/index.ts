/**
 * Gemini TTS on Cloudflare Workers.
 *
 * POST /api/tts  { text, voice?, model?, temperature? }  ->  audio/wav (streamed)
 * GET  /api/voices                                        ->  { voices, models }
 * Everything else is served from ./public via the ASSETS binding.
 *
 * This is a port of the google-genai Python sample. The Worker splits the
 * input into sentence-aligned chunks of a few hundred characters, sends each
 * chunk to the Gemini streaming REST API (streamGenerateContent?alt=sse) with
 * responseModalities=["AUDIO"], and streams the resulting PCM
 * (audio/L16;rate=24000) back to the client, in order, behind a WAV header.
 *
 * Why chunk at all: Cloudflare aborts a subrequest with HTTP 524 when the
 * origin sends no bytes for ~100 s, and the Gemini TTS models emit nothing
 * until the whole utterance is synthesized (even on the SSE endpoint). A
 * long transcript therefore never gets its first byte out in time. Short
 * requests finish well inside the limit, so we make every request short
 * and run a few of them concurrently.
 *
 * Because the total length is unknown when the header is written, the RIFF
 * and data size fields are set to 0xFFFFFFFF ("unknown length", which most
 * players accept). The browser client patches them once the download ends.
 */

export interface Env {
  GEMINI_API_KEY: string;
  /** Optional override, mainly for tests. Defaults to the public Gemini API. */
  GEMINI_API_BASE?: string;
  /** Max characters per Gemini request (default 300). */
  TTS_CHUNK_CHARS?: string;
  /** Concurrent Gemini requests (default 3). */
  TTS_CONCURRENCY?: string;
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
const DEFAULT_CHUNK_CHARS = 300;
const DEFAULT_CONCURRENCY = 3;
const MAX_RETRIES = 2;
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
  const chunkChars = positiveInt(env.TTS_CHUNK_CHARS, DEFAULT_CHUNK_CHARS);
  const concurrency = positiveInt(env.TTS_CONCURRENCY, DEFAULT_CONCURRENCY);
  const chunks = splitText(text, chunkChars);

  const synth = (chunk: string) =>
    synthesizeChunk({ base, apiKey: env.GEMINI_API_KEY, model, voice, temperature, text: chunk });
  const results = inOrder(chunks, concurrency, synth);

  // Wait for the first chunk before committing to response headers, so that
  // API errors still surface as JSON with a proper status code.
  let first: SynthResult;
  try {
    const { value, done } = await results.next();
    if (done) return json({ error: "Nothing to synthesize." }, 400);
    first = value;
  } catch (err) {
    return errorResponse(err);
  }

  const { bitsPerSample, rate } = parseAudioMimeType(first.mimeType);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  const pump = async () => {
    const writer = writable.getWriter();
    try {
      await writer.write(wavHeader(UNKNOWN_SIZE, bitsPerSample, rate));
      await writer.write(first.pcm);
      for (;;) {
        const { value, done } = await results.next();
        if (done) break;
        await writer.write(value.pcm);
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
      "X-Chunks": String(chunks.length),
      "X-Gemini-Model": model,
      "X-Gemini-Voice": voice,
      "X-Source-Mime-Type": first.mimeType,
    },
  });
}

class TtsError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(message: string, status: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof TtsError) return json({ error: err.message, ...err.extra }, err.status);
  console.error("tts failed", err);
  return json({ error: `TTS failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
}

interface SynthResult {
  mimeType: string;
  pcm: Uint8Array;
}

interface SynthParams {
  base: string;
  apiKey: string;
  model: string;
  voice: string;
  temperature: number;
  text: string;
}

/** Synthesizes one chunk of text; retries on 429/5xx. Resolves once all audio has arrived. */
async function synthesizeChunk(p: SynthParams, attempt = 0): Promise<SynthResult> {
  const retry = async (reason: string): Promise<SynthResult> => {
    if (attempt >= MAX_RETRIES) throw new TtsError(`Gemini API error: ${reason}`, 502);
    console.warn(`chunk failed (${reason}); retry ${attempt + 1}/${MAX_RETRIES}`);
    await sleep(1500 * 2 ** attempt);
    return synthesizeChunk(p, attempt + 1);
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${p.base}/models/${p.model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": p.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: p.text }] }],
        generationConfig: {
          temperature: p.temperature,
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice } } },
        },
      }),
    });
  } catch (err) {
    return retry(err instanceof Error ? err.message : String(err));
  }

  if (!upstream.ok) {
    const message = await upstreamErrorMessage(upstream);
    if (upstream.status === 429 || upstream.status >= 500) return retry(`${message} (HTTP ${upstream.status})`);
    throw new TtsError(`Gemini API error: ${message}`, upstream.status);
  }
  if (!upstream.body) return retry("empty response body");

  const parts: Uint8Array[] = [];
  const textParts: string[] = [];
  let mimeType: string | undefined;
  let finishReason: string | undefined;
  for await (const ev of parseSse(upstream.body)) {
    if (ev.error?.message) return retry(ev.error.message);
    if (ev.promptFeedback?.blockReason) {
      throw new TtsError(`Request was blocked: ${ev.promptFeedback.blockReason}`, 422);
    }
    finishReason = ev.candidates?.[0]?.finishReason ?? finishReason;
    for (const part of ev.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        mimeType ??= part.inlineData.mimeType;
        parts.push(base64ToBytes(part.inlineData.data));
      } else if (part.text) {
        textParts.push(part.text);
      }
    }
  }

  if (!mimeType) {
    throw new TtsError("Gemini returned no audio.", 502, {
      finishReason,
      text: textParts.join("\n") || undefined,
      chunk: p.text.slice(0, 80),
    });
  }
  return { mimeType, pcm: concat(parts) };
}

/**
 * Runs `fn` over `items` with at most `concurrency` in flight and yields the
 * results in input order.
 */
export async function* inOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  const inflight: Promise<R>[] = [];
  let next = 0;
  const start = () => {
    if (next >= items.length) return;
    const p = fn(items[next++]);
    p.catch(() => {}); // rejection is observed when awaited in order below
    inflight.push(p);
  };
  for (let i = 0; i < Math.max(1, concurrency); i++) start();
  for (let i = 0; i < items.length; i++) {
    const r = await inflight[i];
    start();
    yield r;
  }
}

/**
 * Splits text into chunks of at most `maxChars`, breaking at paragraph and
 * sentence boundaries where possible. Paragraph breaks are kept as newlines
 * inside a chunk so the model can pause naturally.
 */
export function splitText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = "";
  };

  for (const para of text.split(/\n+/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const sentences = trimmed.match(/.+?(?:[。！？!?]+|(?<!\d)\.(?=\s)|$)/g) ?? [trimmed];
    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        flush();
        for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars).trim());
        continue;
      }
      if (current.length + sentence.length > maxChars) flush();
      current += sentence;
    }
    if (current) current += "\n";
  }
  flush();
  return chunks;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
