import test from "node:test";
import assert from "node:assert/strict";

const { handleAudioSpeech } = await import("../../open-sse/handlers/audioSpeech.ts");
const { audioStreamResponse, sniffAudioMimeType, speechFormatMimeType } =
  await import("../../open-sse/utils/audioResponse.ts");

async function speechWithUpstreamType(upstreamType: string | null, responseFormat?: string) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
      status: 200,
      headers: upstreamType ? { "content-type": upstreamType } : {},
    });
  try {
    const response = await handleAudioSpeech({
      body: { model: "openai/tts-1", input: "hi", voice: "alloy", response_format: responseFormat },
      credentials: { apiKey: "openai-key" },
    });
    return { status: response.status, type: response.headers.get("content-type") };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("speech relabels a 200 audio body sent as application/json (OVMS Kokoro)", async () => {
  const result = await speechWithUpstreamType("application/json; charset=utf-8", "wav");
  assert.deepEqual(result, { status: 200, type: "audio/wav" });
});

test("speech derives the type from response_format when upstream sends none", async () => {
  assert.equal((await speechWithUpstreamType(null, "flac")).type, "audio/flac");
  assert.equal((await speechWithUpstreamType(null, "ogg")).type, "audio/opus");
  assert.equal((await speechWithUpstreamType(null)).type, "audio/mpeg");
});

test("speech keeps a real upstream audio type", async () => {
  assert.equal((await speechWithUpstreamType("audio/x-wav", "wav")).type, "audio/x-wav");
});

test("audioStreamResponse replaces non-audio upstream types with the default", async () => {
  const res = new Response("x", { headers: { "content-type": "application/octet-stream" } });
  const out = await audioStreamResponse(res, "audio/pcm");
  assert.equal(out.headers.get("content-type"), "audio/pcm");
  assert.equal(await out.text(), "x");
});

test("audioStreamResponse sniffs WAV when upstream ignores response_format (OVMS)", async () => {
  const wav = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVEfmt ")]);
  const res = new Response(wav, { headers: { "content-type": "application/json" } });
  const out = await audioStreamResponse(res, "audio/mpeg");
  assert.equal(out.headers.get("content-type"), "audio/wav");
  assert.deepEqual(new Uint8Array(await out.arrayBuffer()), wav);
});

test("sniffAudioMimeType recognises common containers", () => {
  assert.equal(sniffAudioMimeType(Buffer.from("OggS\0")), "audio/ogg");
  assert.equal(sniffAudioMimeType(Buffer.from("fLaC\0")), "audio/flac");
  assert.equal(sniffAudioMimeType(Buffer.from("ID3\x04")), "audio/mpeg");
  assert.equal(sniffAudioMimeType(new Uint8Array([0xff, 0xfb, 0x90])), "audio/mpeg");
  assert.equal(sniffAudioMimeType(new Uint8Array([0xff, 0xf1, 0x50])), "audio/aac");
  assert.equal(sniffAudioMimeType(Buffer.from('{"a":1}')), null);
});

test("speechFormatMimeType maps OpenAI formats", () => {
  assert.equal(speechFormatMimeType("mp3"), "audio/mpeg");
  assert.equal(speechFormatMimeType("WAV"), "audio/wav");
  assert.equal(speechFormatMimeType("aac"), "audio/aac");
  assert.equal(speechFormatMimeType("pcm"), "audio/pcm");
  assert.equal(speechFormatMimeType(undefined), "audio/mpeg");
});
