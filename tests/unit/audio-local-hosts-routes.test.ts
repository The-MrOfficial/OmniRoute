// End-to-end (route-level) coverage for OMNIROUTE_LOCAL_AUDIO_HOSTS: the Arc audio nodes
// live on in-cluster hostnames, which are not loopback. With the allowlist set and
// AUDIO_REMOTE_PROVIDER_NODES left at its default (off), speech and transcription must
// reach them with no connection row, and a configured connection key is still sent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-audio-local-hosts-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "audio-local-hosts-test-secret";
const originalLocalHosts = process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS;
process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS =
  "kokoro-tts.kokoro-service.svc.cluster.local,speaches.speaches-service.svc.cluster.local";

const core = await import("../../src/lib/db/core.ts");
const { createProviderNode, createProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const speechRoute = await import("../../src/app/api/v1/audio/speech/route.ts");
const transcriptionRoute = await import("../../src/app/api/v1/audio/transcriptions/route.ts");

const KOKORO_ID = "openai-compatible-audio-speech-arc-kokoro-allowlist";
const WHISPER_ID = "openai-compatible-audio-transcriptions-arc-whisper-allowlist";

type Captured = { url: string; authorization: string | null };
const originalFetch = globalThis.fetch;

function stubFetch(body: BodyInit, contentType: string): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    calls.push({ url, authorization: headers.get("authorization") });
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalHosts === undefined) delete process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS;
  else process.env.OMNIROUTE_LOCAL_AUDIO_HOSTS = originalLocalHosts;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
test.before(async () => {
  await createProviderNode({
    id: KOKORO_ID,
    type: "openai-compatible",
    name: "Arc Kokoro",
    prefix: "arc-kokoro",
    apiType: "audio-speech",
    baseUrl: "http://kokoro-tts.kokoro-service.svc.cluster.local:8880/v1",
  } as Parameters<typeof createProviderNode>[0]);
  await createProviderNode({
    id: WHISPER_ID,
    type: "openai-compatible",
    name: "Arc Whisper",
    prefix: "arc-whisper",
    apiType: "audio-transcriptions",
    baseUrl: "http://speaches.speaches-service.svc.cluster.local:8000/v1",
  } as Parameters<typeof createProviderNode>[0]);
  await createProviderNode({
    id: "openai-compatible-audio-speech-remote-not-allowlisted",
    type: "openai-compatible",
    name: "Remote TTS",
    prefix: "remote-tts",
    apiType: "audio-speech",
    baseUrl: "http://stt.example.test/v1",
  } as Parameters<typeof createProviderNode>[0]);
});

function speechRequest(model: string) {
  return new Request("http://localhost/api/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "hello arc", voice: "af_heart" }),
  });
}

/** Minimal but structurally valid WAV so nothing rejects the upload shape. */
function makeWav(): Blob {
  const dataLen = 1600;
  const b = Buffer.alloc(44 + dataLen);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + dataLen, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(dataLen, 40);
  return new Blob([b], { type: "audio/wav" });
}

test("speech to an allowlisted cluster node succeeds with no connection and no auth", async () => {
  const calls = stubFetch(new Uint8Array([1, 2, 3, 4]), "audio/mpeg");
  const res = await speechRoute.POST(speechRequest("arc-kokoro/Kokoro-82M-int8-ov"), {});
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "http://kokoro-tts.kokoro-service.svc.cluster.local:8880/v1/audio/speech"
  );
  assert.equal(calls[0].authorization, null);
});

test("transcription to an allowlisted cluster node succeeds with no auth", async () => {
  const calls = stubFetch(JSON.stringify({ text: "hi" }), "application/json");
  const fd = new FormData();
  fd.set("model", "arc-whisper/distil-whisper-large-v3-int8-ov");
  fd.set("file", makeWav(), "t.wav");
  const res = await transcriptionRoute.POST(
    new Request("http://localhost/api/v1/audio/transcriptions", { method: "POST", body: fd })
  );
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("http://speaches.speaches-service.svc.cluster.local:8000/v1"));
  assert.equal(calls[0].authorization, null);
});

test("a non-allowlisted remote node is still rejected with the flag off", async () => {
  const calls = stubFetch(new Uint8Array([1]), "audio/mpeg");
  const res = await speechRoute.POST(speechRequest("remote-tts/some-voice"), {});
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("speech to an allowlisted node still sends a configured connection key", async () => {
  await createProviderConnection({
    provider: KOKORO_ID,
    authType: "apikey",
    apiKey: "sk-local-test",
    isActive: true,
    testStatus: "active",
    priority: 1,
    name: "arc-kokoro-key",
  });
  const calls = stubFetch(new Uint8Array([1, 2, 3, 4]), "audio/mpeg");
  const res = await speechRoute.POST(speechRequest("arc-kokoro/Kokoro-82M-int8-ov"), {});
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, "Bearer sk-local-test");
});
