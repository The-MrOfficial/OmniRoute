import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  RequestCompletedPayload as CompletedPayload,
  RequestStartedPayload as StartedPayload,
} from "../../src/lib/events/types.ts";

// The Arc OVMS embedding server pads a whole input array into one GPU batch, so a
// 700-item request OOM-kills the pod. OmniRoute splits oversized arrays for the
// arc-embed / ovms-arc nodes and merges the sub-responses into one logical request.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-embed-batch-split-"));
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS;
delete process.env.OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEMS;
delete process.env.OMNIROUTE_EMBEDDING_SPLIT_MAX_PADDED_TOKENS;

const split = await import("../../open-sse/handlers/embeddingBatchSplit.ts");
const { handleEmbedding } = await import("../../open-sse/handlers/embeddings.ts");
const { on } = await import("../../src/lib/events/eventBus.ts");
const { getCallLogs } = await import("../../src/lib/usage/callLogs.ts");
const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function provider(id: string) {
  return {
    id,
    baseUrl: "http://localhost:8000/v3/embeddings",
    authType: "none" as const,
    authHeader: "none" as const,
    models: [],
  };
}

/** Inputs are "item-<n>-<padding>"; the fake vector is [n] so order is checkable. */
function makeInputs(count: number): string[] {
  return Array.from({ length: count }, (_, n) => `item-${n}-${"x".repeat(50 + ((n * 37) % 1050))}`);
}

interface UpstreamCall {
  input: unknown;
}

/**
 * Fake OpenAI-compatible upstream. Each sub-response lists its items in reverse
 * order (with correct local indices) to prove the merge sorts by index, and reports
 * one prompt token per item.
 */
function mockUpstream(failWhen?: (input: unknown[]) => number | null) {
  const calls: UpstreamCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: unknown };
    calls.push({ input: body.input });
    const items = Array.isArray(body.input) ? body.input : [body.input];
    const failStatus = failWhen?.(items) ?? null;
    if (failStatus) {
      return new Response(JSON.stringify({ error: { message: "boom" } }), { status: failStatus });
    }
    const data = items
      .map((item, index) => ({
        object: "embedding",
        index,
        embedding: [Number(String(item).split("-")[1])],
      }))
      .reverse();
    return new Response(
      JSON.stringify({
        object: "list",
        data,
        model: "qwen3-embedding-0.6b",
        usage: { prompt_tokens: items.length, total_tokens: items.length },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function embed(
  providerId: string,
  input: unknown,
  apiKeyId = "split-test",
  signal: AbortSignal | null = null
) {
  return handleEmbedding({
    body: { model: `${providerId}/qwen3-embedding-0.6b`, input },
    credentials: null,
    resolvedProvider: provider(providerId),
    resolvedModel: "qwen3-embedding-0.6b",
    apiKeyId,
    apiKeyName: apiKeyId,
    signal,
  });
}

async function waitForCallLogs(apiKeyId: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await getCallLogs({ apiKey: apiKeyId, limit: 10 });
    if (logs.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return getCallLogs({ apiKey: apiKeyId, limit: 10 });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

type EmbeddingItem = { index: number; embedding: number[] };

test("resolveEmbeddingSplitLimits: defaults on for arc-embed/ovms-arc only", () => {
  const env = {};
  assert.deepEqual(split.resolveEmbeddingSplitLimits("arc-embed", env), {
    maxItems: 32,
    maxPaddedTokens: 32_768,
    maxItemTokens: 4096,
  });
  assert.ok(split.resolveEmbeddingSplitLimits("ovms-arc", env));
  assert.equal(split.resolveEmbeddingSplitLimits("openai", env), null);
});

test("resolveEmbeddingSplitLimits: env list, per-provider override, wildcard, off", () => {
  const env = {
    OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS: "arc-embed=8:4000, lan=:9000, *",
    OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEMS: "16",
  };
  assert.deepEqual(split.resolveEmbeddingSplitLimits("arc-embed", env), {
    maxItems: 8,
    maxPaddedTokens: 4000,
    maxItemTokens: 4096,
  });
  assert.deepEqual(split.resolveEmbeddingSplitLimits("lan", env), {
    maxItems: 16,
    maxPaddedTokens: 9000,
    maxItemTokens: 4096,
  });
  assert.deepEqual(split.resolveEmbeddingSplitLimits("openai", env), {
    maxItems: 16,
    maxPaddedTokens: 32_768,
    maxItemTokens: 4096,
  });
  for (const off of ["", "none", "off"]) {
    assert.equal(
      split.resolveEmbeddingSplitLimits("arc-embed", { OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS: off }),
      null
    );
  }
});

test("planEmbeddingBatches: item cap and padded-token budget, contiguous and complete", () => {
  const limits = { maxItems: 4, maxPaddedTokens: 1000, maxItemTokens: 4096 };
  assert.equal(split.planEmbeddingBatches("one string", limits), null);
  assert.equal(split.planEmbeddingBatches(["a", "b", "c"], limits), null);
  assert.deepEqual(split.planEmbeddingBatches(["a", "b", "c", "d", "e"], limits), [
    { start: 0, end: 4 },
    { start: 4, end: 5 },
  ]);
  // 600 chars ≈ 200 tokens; two of them pad to 400 (ok), a third 1200-char item
  // (400 tokens) would pad three items to 1200 > 1000, so it opens a new batch.
  const padded = ["x".repeat(600), "x".repeat(600), "x".repeat(1200), "a"];
  assert.deepEqual(split.planEmbeddingBatches(padded, limits), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  // Structured items are never split.
  assert.equal(split.planEmbeddingBatches([{ type: "text", text: "a" }, "b"], limits), null);
});

test("700 inputs to arc-embed: split into ≤32-item sub-requests, order preserved, usage summed", async () => {
  const upstream = mockUpstream();
  const started: StartedPayload[] = [];
  const completed: CompletedPayload[] = [];
  const offs = [
    on("request.started", (p) => started.push(p)),
    on("request.completed", (p) => completed.push(p)),
  ];
  try {
    const inputs = makeInputs(700);
    const result = await embed("arc-embed", inputs, "split-700");
    assert.equal(result.success, true);
    assert.ok(
      upstream.calls.length >= 22,
      `expected ≥22 sub-requests, got ${upstream.calls.length}`
    );
    const sent = upstream.calls.flatMap((call) => call.input as string[]);
    assert.deepEqual(sent, inputs, "sub-requests cover every input exactly once, in order");
    for (const call of upstream.calls) assert.ok((call.input as unknown[]).length <= 32);

    const data = result.data!.data as EmbeddingItem[];
    assert.equal(data.length, 700);
    data.forEach((item, position) => {
      assert.equal(item.index, position);
      assert.deepEqual(item.embedding, [position]);
    });
    assert.deepEqual(result.data!.usage, { prompt_tokens: 700, total_tokens: 700 });
    assert.equal(result.data!.model, "arc-embed/qwen3-embedding-0.6b");

    await new Promise(setImmediate);
    const arcStarted = started.filter((e) => e.provider === "arc-embed");
    assert.equal(arcStarted.length, 1, "one logical live request");
    const done = completed.filter((e) => e.id === arcStarted[0].id);
    assert.equal(done.length, 1);
    assert.equal(done[0].tokensInput, 700);

    const logs = await waitForCallLogs("split-700");
    assert.equal(logs.length, 1, "one call_logs row for the logical request");
    assert.equal(logs[0].status, 200);
    assert.equal(logs[0].tokens.in, 700);
  } finally {
    offs.forEach((off) => off());
    upstream.restore();
  }
});

test("single-string input is forwarded untouched", async () => {
  const upstream = mockUpstream();
  try {
    const result = await embed("arc-embed", "item-5-hello");
    assert.equal(result.success, true);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].input, "item-5-hello");
  } finally {
    upstream.restore();
  }
});

test("small arrays are forwarded untouched in one request", async () => {
  const upstream = mockUpstream();
  try {
    const inputs = makeInputs(32);
    const result = await embed("arc-embed", inputs);
    assert.equal(result.success, true);
    assert.equal(upstream.calls.length, 1);
    assert.deepEqual(upstream.calls[0].input, inputs);
  } finally {
    upstream.restore();
  }
});

test("providers not configured for splitting get the full array in one request", async () => {
  const upstream = mockUpstream();
  try {
    const inputs = makeInputs(100);
    const result = await embed("lan-other", inputs);
    assert.equal(result.success, true);
    assert.equal(upstream.calls.length, 1);
    assert.deepEqual(upstream.calls[0].input, inputs);
  } finally {
    upstream.restore();
  }
});

test("a 5xx sub-batch is split once instead of resent; halves succeed", async () => {
  // The upstream rejects any batch larger than 20 items, as an OOM-ing server would.
  const upstream = mockUpstream((items) => (items.length > 20 ? 502 : null));
  try {
    const inputs = makeInputs(40);
    const result = await embed("arc-embed", inputs);
    assert.equal(result.success, true);
    // [0,32) fails → halves [0,16) and [16,32); then [32,40).
    assert.deepEqual(
      upstream.calls.map((call) => (call.input as unknown[]).length),
      [32, 16, 16, 8]
    );
    const data = result.data!.data as EmbeddingItem[];
    assert.deepEqual(
      data.map((item) => item.embedding[0]),
      inputs.map((_, n) => n)
    );
    assert.deepEqual(result.data!.usage, { prompt_tokens: 40, total_tokens: 40 });
  } finally {
    upstream.restore();
  }
});

test("a sub-batch that still fails after one split fails the request without more retries", async () => {
  const upstream = mockUpstream((items) => (items.length > 4 ? 500 : null));
  try {
    const result = await embed("arc-embed", makeInputs(40), "split-fail");
    assert.equal(result.success, false);
    assert.equal(result.status, 500);
    // [0,32) fails → [0,16) fails and is not split again.
    assert.deepEqual(
      upstream.calls.map((call) => (call.input as unknown[]).length),
      [32, 16]
    );
    const logs = await waitForCallLogs("split-fail");
    assert.equal(logs.length, 1, "one failed call_logs row");
    assert.equal(logs[0].status, 500);
  } finally {
    upstream.restore();
  }
});

test("a connection reset on a sub-batch is split once, like a 5xx", async () => {
  const upstream = mockUpstream();
  const succeed = globalThis.fetch;
  const sizes: number[] = [];
  globalThis.fetch = async (url: unknown, init?: RequestInit) => {
    const size = (JSON.parse(String(init?.body)) as { input: unknown[] }).input.length;
    sizes.push(size);
    if (size > 20) throw new TypeError("fetch failed: other side closed");
    return succeed(url as string, init);
  };
  try {
    const result = await embed("arc-embed", makeInputs(40));
    assert.equal(result.success, true);
    assert.deepEqual(sizes, [32, 16, 16, 8]);
    assert.equal((result.data!.data as EmbeddingItem[]).length, 40);
  } finally {
    upstream.restore();
  }
});

test("a 4xx sub-batch is returned as-is without splitting", async () => {
  const upstream = mockUpstream(() => 400);
  try {
    const result = await embed("arc-embed", makeInputs(40));
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.equal(upstream.calls.length, 1);
  } finally {
    upstream.restore();
  }
});

/** Position of an "item-<n>-..." input, for failing specific sub-batches. */
function itemNumber(item: unknown): number {
  return Number(String(item).split("-")[1]);
}

test("a terminal sub-batch failure records tokens spent by earlier sub-batches", async () => {
  // [0,32) succeeds; [32,40) and both halves fail.
  const upstream = mockUpstream((items) => (itemNumber(items[0]) >= 32 ? 503 : null));
  try {
    const result = await embed("arc-embed", makeInputs(40), "split-partial");
    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.deepEqual(
      upstream.calls.map((call) => (call.input as unknown[]).length),
      [32, 8, 4]
    );
    const logs = await waitForCallLogs("split-partial");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 503);
    assert.equal(logs[0].tokens.in, 32, "tokens from the successful [0,32) sub-batch");
  } finally {
    upstream.restore();
  }
});

test("a client abort stops the split loop before the next sub-batch", async () => {
  const upstream = mockUpstream();
  const succeed = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (url: unknown, init?: RequestInit) => {
    const response = await succeed(url as string, init);
    controller.abort();
    return response;
  };
  try {
    const result = await embed("arc-embed", makeInputs(100), "split-abort", controller.signal);
    assert.equal(result.success, false);
    assert.equal(result.status, 499);
    assert.equal(upstream.calls.length, 1, "no sub-batch is sent after the abort");
    const logs = await waitForCallLogs("split-abort");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 499);
    assert.equal(logs[0].tokens.in, 32);
  } finally {
    upstream.restore();
  }
});
