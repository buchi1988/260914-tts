// Unit tests for the pure helpers in src/index.ts.
// Run with: npm test   (Node 22+, uses --experimental-strip-types)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitText, inOrder, parseSse, parseAudioMimeType, wavHeader, toWav } from "../src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// ---------- parseAudioMimeType ----------
assert.deepEqual(parseAudioMimeType("audio/L16;codec=pcm;rate=24000"), { bitsPerSample: 16, rate: 24000 });
assert.deepEqual(parseAudioMimeType("audio/L24;rate=48000"), { bitsPerSample: 24, rate: 48000 });
assert.deepEqual(parseAudioMimeType("audio/pcm"), { bitsPerSample: 16, rate: 24000 });

// ---------- WAV header ----------
{
  const pcm = new Uint8Array(1000).fill(7);
  const wav = toWav(pcm, "audio/L16;codec=pcm;rate=24000");
  const v = new DataView(wav.buffer);
  const ascii = (o, n) => String.fromCharCode(...wav.subarray(o, o + n));
  assert.equal(wav.byteLength, 1044);
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(v.getUint32(4, true), 1036);
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 24000);
  assert.equal(v.getUint32(28, true), 48000);
  assert.equal(v.getUint16(32, true), 2);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(ascii(36, 4), "data");
  assert.equal(v.getUint32(40, true), 1000);
  assert.equal(wav[44], 7);
  assert.equal(wav[1043], 7);

  const streaming = new DataView(wavHeader(0xffffffff, 16, 24000).buffer);
  assert.equal(streaming.getUint32(4, true), 0xffffffff);
  assert.equal(streaming.getUint32(40, true), 0xffffffff);
}

// ---------- parseSse ----------
{
  const enc = new TextEncoder();
  const sse = 'event: x\r\ndata: {"a":1}\r\n\r\n: comment\ndata: {"b":\n\ndata: [DONE]\n';
  const body = new ReadableStream({
    start(c) {
      // Split at awkward places to exercise the cross-read buffering.
      c.enqueue(enc.encode(sse.slice(0, 5)));
      c.enqueue(enc.encode(sse.slice(5, 30)));
      c.enqueue(enc.encode(sse.slice(30)));
      c.enqueue(enc.encode('data: {"c":3}')); // no trailing newline
      c.close();
    },
  });
  const got = [];
  for await (const ev of parseSse(body)) got.push(ev);
  assert.deepEqual(got, [{ a: 1 }, { c: 3 }]);
}

// ---------- splitText ----------
{
  // The article that ships as the default text in public/index.html.
  const html = readFileSync(`${root}public/index.html`, "utf8");
  const article = html
    .match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const chunks = splitText(article, 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 300));
  assert.equal(chunks.join("").replace(/\s+/g, ""), article.replace(/\s+/g, ""), "no text lost");
  for (const c of chunks.slice(0, -1)) {
    const lastLine = c.split("\n").pop();
    assert.ok(/[。！？!?]$/.test(c) || article.includes(lastLine + "\n"), "bad boundary: " + c.slice(-20));
  }

  const en = splitText("Version 2.5 is out. It is good! Really? Yes.\n\nNext para here.", 40);
  assert.ok(en.every((c) => c.length <= 40));
  assert.ok(en.some((c) => c.includes("2.5")), "decimal must not be split");
  assert.ok(en.every((c) => /[.!?]$/.test(c)), "chunks end at sentence ends");
  assert.ok(en.some((c) => c.includes("Yes.\nNext")), "paragraph break kept as newline");

  assert.deepEqual(splitText("a".repeat(25), 10), ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  assert.deepEqual(splitText("   \n\n  ", 10), []);
}

// ---------- inOrder ----------
{
  let active = 0, maxActive = 0;
  const gen = inOrder([5, 1, 4, 2, 3], 2, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, n * 20));
    active--;
    return n * 10;
  });
  const out = [];
  for await (const r of gen) out.push(r);
  assert.deepEqual(out, [50, 10, 40, 20, 30], "results come back in input order");
  assert.equal(maxActive, 2, "concurrency is bounded");

  const bad = inOrder([1, 2, 3], 3, async (n) => { if (n === 2) throw new Error("boom"); return n; });
  assert.equal((await bad.next()).value, 1);
  await assert.rejects(() => bad.next(), /boom/);
}

console.log("all unit tests passed");
