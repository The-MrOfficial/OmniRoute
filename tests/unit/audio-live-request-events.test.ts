// The home topology lights the Arc Kokoro / Arc Whisper nodes only when the audio routes
// emit the same live lifecycle events as chat, keyed by the node prefix (= call-log provider).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  RequestCompletedPayload,
  RequestFailedPayload,
  RequestStartedPayload,
} from "../../src/lib/events/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-audio-live-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "audio-live-test-api-key-secret";
const core = await import("../../src/lib/db/core.ts");
const { createProviderNode } = await import("../../src/lib/db/providers.ts");
const { on } = await import("../../src/lib/events/eventBus.ts");
const speechRoute = await import("../../src/app/api/v1/audio/speech/route.ts");
const transcriptionRoute = await import("../../src/app/api/v1/audio/transcriptions/route.ts");

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.before(async () => {
  await createProviderNode({
    id: "openai-compatible-audio-speech-arc-kokoro-test",
    type: "openai-compatible",
    name: "Arc Kokoro",
    prefix: "arc-kokoro",
    apiType: "audio-speech",
    baseUrl: "http://localhost:18999/v1",
  } as Parameters<typeof createProviderNode>[0]);
  await createProviderNode({
    id: "openai-compatible-audio-transcriptions-arc-whisper-test",
    type: "openai-compatible",
    name: "Arc Whisper",
    prefix: "arc-whisper",
    apiType: "audio-transcriptions",
    baseUrl: "http://localhost:18999/v1",
  } as Parameters<typeof createProviderNode>[0]);
});

function capture() {
  const started: RequestStartedPayload[] = [];
  const completed: RequestCompletedPayload[] = [];
  const failed: RequestFailedPayload[] = [];
  const offs = [
    on("request.started", (p) => started.push(p)),
    on("request.completed", (p) => completed.push(p)),
    on("request.failed", (p) => failed.push(p)),
  ];
  return { started, completed, failed, stop: () => offs.forEach((off) => off()) };
}

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

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

function speechRequest() {
  return new Request("http://localhost/api/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "arc-kokoro/kokoro", input: "hello arc", voice: "af_heart" }),
  });
}

test("speech via arc-kokoro emits request.started + request.completed", async () => {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    })) as typeof fetch;
  const events = capture();
  try {
    const res = await speechRoute.POST(speechRequest(), {});
    assert.equal(res.status, 200, await res.clone().text());
    await flush();
    const started = events.started.filter((e) => e.provider === "arc-kokoro");
    assert.equal(started.length, 1);
    const completed = events.completed.filter((e) => e.id === started[0].id);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].provider, "arc-kokoro");
    assert.equal(events.failed.filter((e) => e.id === started[0].id).length, 0);
  } finally {
    events.stop();
  }
});

test("speech upstream 500 via arc-kokoro emits request.failed with the same id", async () => {
  globalThis.fetch = (async () => new Response("kokoro exploded", { status: 500 })) as typeof fetch;
  const events = capture();
  try {
    const res = await speechRoute.POST(speechRequest(), {});
    assert.notEqual(res.status, 200);
    await flush();
    const started = events.started.filter((e) => e.provider === "arc-kokoro");
    assert.equal(started.length, 1);
    const failed = events.failed.filter((e) => e.id === started[0].id);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].provider, "arc-kokoro");
    assert.equal(events.completed.filter((e) => e.id === started[0].id).length, 0);
  } finally {
    events.stop();
  }
});

test("transcription via arc-whisper emits request.started + request.completed", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ text: "hi" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const events = capture();
  try {
    const fd = new FormData();
    fd.set("model", "arc-whisper/distil-whisper-large-v3-int8-ov");
    fd.set("file", makeWav(), "t.wav");
    const res = await transcriptionRoute.POST(
      new Request("http://localhost/api/v1/audio/transcriptions", { method: "POST", body: fd })
    );
    assert.equal(res.status, 200, await res.clone().text());
    await flush();
    const started = events.started.filter((e) => e.provider === "arc-whisper");
    assert.equal(started.length, 1);
    assert.equal(started[0].model, "distil-whisper-large-v3-int8-ov");
    const completed = events.completed.filter((e) => e.id === started[0].id);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].provider, "arc-whisper");
  } finally {
    events.stop();
  }
});
