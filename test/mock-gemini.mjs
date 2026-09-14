// Mock of the Gemini streamGenerateContent?alt=sse endpoint for local end-to-end tests.
//
//   node test/mock-gemini.mjs            # listens on :9999
//   echo 'GEMINI_API_KEY=test' > .dev.vars
//   echo 'GEMINI_API_BASE=http://127.0.0.1:9999/v1beta' >> .dev.vars
//   npx wrangler dev
//   curl -X POST localhost:8787/api/tts -H 'Content-Type: application/json' \
//        -d '{"text":"こんにちは。世界。"}' -o out.wav
//
// Behaviour:
//   - "PCM" is `text.length * 8000` bytes filled with the call index, so the
//     output order can be checked byte by byte (~2.4 MB per 300-char chunk,
//     about what the real models return).
//   - Every call waits ~1 s; the 3rd call ever returns 429 once to exercise retry.
//   - text "BADKEY" -> 400, "BLOCK" -> promptFeedback.blockReason, "NOAUDIO" -> text only.
import http from "node:http";

const PORT = Number(process.env.PORT || 9999);
let calls = 0;

http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const text = JSON.parse(body).contents[0].parts[0].text;
  const n = ++calls;
  console.log(`call#${n} ${req.url} len=${text.length} head=${text.slice(0, 16).replace(/\n/g, "⏎")}`);

  const jsonError = (status, message) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message, status: "ERROR" } }));
  };
  const sse = (events) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.end();
  };

  if (text === "BADKEY") return jsonError(400, "API key not valid. Please pass a valid API key.");
  if (n === 3) return jsonError(429, "Resource exhausted (mock, once)");
  if (text === "BLOCK") return sse([{ promptFeedback: { blockReason: "SAFETY" } }]);
  if (text === "NOAUDIO") {
    return sse([{ candidates: [{ content: { parts: [{ text: "I cannot do that" }] }, finishReason: "STOP" }] }]);
  }

  await new Promise((r) => setTimeout(r, 1000));
  const pcm = Buffer.alloc(text.length * 8000, n & 0xff);
  sse([
    { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }] },
    { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] },
  ]);
}).listen(PORT, () => console.log(`mock gemini listening on ${PORT}`));
