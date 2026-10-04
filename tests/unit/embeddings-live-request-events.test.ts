import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RequestCompletedPayload as CompletedPayload,
  RequestFailedPayload as FailedPayload,
  RequestStartedPayload as StartedPayload,
} from "../../src/lib/events/types.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-embeddings-live-"));
const { handleEmbedding } = await import("../../open-sse/handlers/embeddings.ts");
const { on } = await import("../../src/lib/events/eventBus.ts");

// The home topology lights the Arc embeddings node only when /v1/embeddings emits the
// same live lifecycle events as chat, keyed by the node prefix (= call-log provider).

const arcEmbed = {
  id: "arc-embed",
  baseUrl: "http://localhost:8000/v3/embeddings",
  authType: "none" as const,
  authHeader: "none" as const,
  models: [],
};

function mockUpstream(status: number, payload: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  return () => {
    globalThis.fetch = original;
  };
}

function capture() {
  const started: StartedPayload[] = [];
  const completed: CompletedPayload[] = [];
  const failed: FailedPayload[] = [];
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

const arcStarted = (list: StartedPayload[]) => list.filter((e) => e.provider === "arc-embed");

test("handleEmbedding success emits request.started + request.completed for arc-embed", async () => {
  const restore = mockUpstream(200, {
    data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
    usage: { prompt_tokens: 3, total_tokens: 3 },
  });
  const events = capture();
  try {
    const result = await handleEmbedding({
      body: { model: "arc-embed/qwen3-embedding-0.6b", input: "hello" },
      credentials: null,
      resolvedProvider: arcEmbed,
      resolvedModel: "qwen3-embedding-0.6b",
      log: null,
    });
    assert.equal(result.success, true);
    await flush();
    const started = arcStarted(events.started);
    assert.equal(started.length, 1);
    assert.equal(started[0].model, "qwen3-embedding-0.6b");
    const completed = events.completed.filter((e) => e.id === started[0].id);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].provider, "arc-embed");
    assert.equal(completed[0].tokensInput, 3);
    assert.equal(events.failed.filter((e) => e.id === started[0].id).length, 0);
  } finally {
    events.stop();
    restore();
  }
});

test("handleEmbedding upstream 500 emits request.failed for arc-embed with the same id", async () => {
  const restore = mockUpstream(500, { error: { message: "boom" } });
  const events = capture();
  try {
    const result = await handleEmbedding({
      body: { model: "arc-embed/qwen3-embedding-0.6b", input: "hello" },
      credentials: null,
      resolvedProvider: arcEmbed,
      resolvedModel: "qwen3-embedding-0.6b",
      log: null,
    });
    assert.equal(result.success, false);
    await flush();
    const started = arcStarted(events.started);
    assert.equal(started.length, 1);
    const failed = events.failed.filter((e) => e.id === started[0].id);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].provider, "arc-embed");
    assert.equal(failed[0].statusCode, 500);
    assert.equal(events.completed.filter((e) => e.id === started[0].id).length, 0);
  } finally {
    events.stop();
    restore();
  }
});
