import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One oversized item is one long OVMS inference on the Arc iGPU, long enough to trip the
// i915 watchdog. For split-enabled providers OmniRoute caps every item before dispatch:
// internal callers (memory/Qdrant) get it truncated, external callers get a 400, and no
// retry/re-split path ever resends the original oversized item.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-embed-item-cap-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const ENV_KEYS = [
  "OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS",
  "OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEMS",
  "OMNIROUTE_EMBEDDING_SPLIT_MAX_PADDED_TOKENS",
  "OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS",
  "OMNIROUTE_EMBEDDING_ITEM_OVERFLOW",
] as const;
for (const key of ENV_KEYS) delete process.env[key];

const split = await import("../../open-sse/handlers/embeddingBatchSplit.ts");
const { handleEmbedding } = await import("../../open-sse/handlers/embeddings.ts");
const core = await import("../../src/lib/db/core.ts");

test.afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 4096 tokens × 3 chars/token. */
const DEFAULT_CAP_CHARS = 12_288;
const LONG_TEXT = "a".repeat(20_000);

function provider(id: string) {
  return {
    id,
    baseUrl: "http://localhost:8000/v3/embeddings",
    authType: "none" as const,
    authHeader: "none" as const,
    models: [],
  };
}

type FetchOutcome = "ok" | number | "timeout";

/** Fake upstream; `decide` picks the outcome per request from the parsed input. */
function mockUpstream(decide: (input: unknown) => FetchOutcome = () => "ok") {
  const calls: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: unknown };
    calls.push(body.input);
    const outcome = decide(body.input);
    if (outcome === "timeout") {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    if (typeof outcome === "number") {
      return new Response(JSON.stringify({ error: { message: "boom" } }), { status: outcome });
    }
    const items =
      Array.isArray(body.input) && typeof body.input[0] !== "number" ? body.input : [body.input];
    return new Response(
      JSON.stringify({
        object: "list",
        data: items.map((_item, index) => ({ object: "embedding", index, embedding: [index] })),
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

function makeLog() {
  const warnings: string[] = [];
  return {
    warnings,
    log: {
      info: () => {},
      warn: (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      },
      error: () => {},
    },
  };
}

async function embed(
  input: unknown,
  options: { internalCaller?: boolean; providerId?: string; log?: ReturnType<typeof makeLog> } = {}
) {
  const providerId = options.providerId ?? "arc-embed";
  return handleEmbedding({
    body: { model: `${providerId}/qwen3-embedding-0.6b`, input },
    credentials: null,
    resolvedProvider: provider(providerId),
    resolvedModel: "qwen3-embedding-0.6b",
    internalCaller: options.internalCaller,
    log: options.log?.log,
  });
}

function itemLengths(calls: unknown[]): number[] {
  return calls.flatMap((input) =>
    (Array.isArray(input) ? input : [input]).map((item) => String(item).length)
  );
}

test("capEmbeddingItems: truncates strings and token arrays, passes structured items", () => {
  const single = split.capEmbeddingItems("x".repeat(40), 10);
  assert.equal(single.input, "x".repeat(30));
  assert.deepEqual(single.overflows, [{ index: 0, estimatedTokens: 14 }]);

  const tokens = Array.from({ length: 25 }, (_, n) => n);
  const tokenResult = split.capEmbeddingItems(tokens, 10);
  assert.deepEqual(tokenResult.input, tokens.slice(0, 10));

  const structured = { type: "image", url: "https://example.com/a.png" };
  const mixed = ["short", "y".repeat(100), structured, tokens];
  const mixedResult = split.capEmbeddingItems(mixed, 10);
  assert.deepEqual(mixedResult.input, ["short", "y".repeat(30), structured, tokens.slice(0, 10)]);
  assert.deepEqual(
    mixedResult.overflows.map((overflow) => overflow.index),
    [1, 3]
  );

  const untouched = ["a", "b"];
  assert.equal(split.capEmbeddingItems(untouched, 10).input, untouched);
});

test("resolveEmbeddingSplitLimits: parses the per-item cap globally and per provider", () => {
  assert.equal(split.resolveEmbeddingSplitLimits("arc-embed", {})?.maxItemTokens, 4096);
  assert.equal(
    split.resolveEmbeddingSplitLimits("arc-embed", {
      OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS: "2048",
    })?.maxItemTokens,
    2048
  );
  const env = { OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS: "arc-embed=::1000,ovms-arc=8:4000" };
  assert.deepEqual(split.resolveEmbeddingSplitLimits("arc-embed", env), {
    maxItems: 32,
    maxPaddedTokens: 32_768,
    maxItemTokens: 1000,
  });
  assert.equal(split.resolveEmbeddingSplitLimits("ovms-arc", env)?.maxItemTokens, 4096);
  assert.equal(split.resolveEmbeddingItemOverflowMode({}), "auto");
  assert.equal(
    split.resolveEmbeddingItemOverflowMode({ OMNIROUTE_EMBEDDING_ITEM_OVERFLOW: "Reject" }),
    "reject"
  );
  assert.equal(
    split.resolveEmbeddingItemOverflowMode({ OMNIROUTE_EMBEDDING_ITEM_OVERFLOW: "bogus" }),
    "auto"
  );
});

test("internal caller: an over-cap string is truncated to the cap with a warning", async () => {
  const upstream = mockUpstream();
  const log = makeLog();
  try {
    const result = await embed(LONG_TEXT, { internalCaller: true, log });
    assert.equal(result.success, true);
    assert.equal(upstream.calls.length, 1);
    assert.equal(String(upstream.calls[0]).length, DEFAULT_CAP_CHARS);
    assert.equal(log.warnings.length, 1);
    assert.match(log.warnings[0], /4096-token per-item cap/);
  } finally {
    upstream.restore();
  }
});

test("external caller: an over-cap item is rejected with 400 and never sent", async () => {
  const upstream = mockUpstream();
  try {
    const result = await embed(LONG_TEXT);
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.match(String(result.error), /4096-token per-item limit/);
    assert.match(String(result.error), /OMNIROUTE_EMBEDDING_ITEM_OVERFLOW=truncate/);
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test("OMNIROUTE_EMBEDDING_ITEM_OVERFLOW forces truncate or reject for every caller", async () => {
  const upstream = mockUpstream();
  try {
    process.env.OMNIROUTE_EMBEDDING_ITEM_OVERFLOW = "truncate";
    const external = await embed(LONG_TEXT);
    assert.equal(external.success, true);
    assert.equal(String(upstream.calls[0]).length, DEFAULT_CAP_CHARS);

    process.env.OMNIROUTE_EMBEDDING_ITEM_OVERFLOW = "reject";
    const internal = await embed(LONG_TEXT, { internalCaller: true });
    assert.equal(internal.success, false);
    assert.equal(internal.status, 400);
    assert.equal(upstream.calls.length, 1);
  } finally {
    upstream.restore();
  }
});

test("an over-cap token-id array is sliced to maxItemTokens", async () => {
  const upstream = mockUpstream();
  try {
    const tokens = Array.from({ length: 5000 }, (_, n) => n % 100);
    const result = await embed(tokens, { internalCaller: true });
    assert.equal(result.success, true);
    assert.deepEqual(upstream.calls[0], tokens.slice(0, 4096));
  } finally {
    upstream.restore();
  }
});

test("per-provider and global env caps change the truncation length", async () => {
  const upstream = mockUpstream();
  try {
    process.env.OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS = "arc-embed=::1000";
    await embed(LONG_TEXT, { internalCaller: true });
    assert.equal(String(upstream.calls[0]).length, 3000);

    delete process.env.OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS;
    process.env.OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS = "2048";
    await embed(LONG_TEXT, { internalCaller: true });
    assert.equal(String(upstream.calls[1]).length, 6144);
  } finally {
    upstream.restore();
  }
});

test("a provider without splitting forwards a 20k input unchanged", async () => {
  const upstream = mockUpstream();
  try {
    const result = await embed(LONG_TEXT, { providerId: "openai" });
    assert.equal(result.success, true);
    assert.equal(String(upstream.calls[0]).length, 20_000);
  } finally {
    upstream.restore();
  }
});

test("no unchanged resend: a 503 re-split never carries the original oversized item", async () => {
  const upstream = mockUpstream((input) =>
    Array.isArray(input) && input.length === 2 ? 503 : "ok"
  );
  try {
    // maxItems 2 → sub-batches [short, long] and [tail]; the first 503s and is halved once.
    process.env.OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS = "arc-embed=2";
    const result = await embed(["short", LONG_TEXT, "tail"], { internalCaller: true });
    assert.equal(result.success, true);
    assert.equal(upstream.calls.length, 4);
    for (const length of itemLengths(upstream.calls)) {
      assert.ok(length <= DEFAULT_CAP_CHARS, `item of ${length} chars was sent`);
    }
    assert.ok(!upstream.calls.some((input) => JSON.stringify(input).includes(LONG_TEXT)));
  } finally {
    upstream.restore();
  }
});

test("no unchanged resend: a single over-cap item that 503s is sent once, truncated", async () => {
  const upstream = mockUpstream(() => 503);
  try {
    const result = await embed(LONG_TEXT, { internalCaller: true });
    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.equal(upstream.calls.length, 1);
    assert.equal(String(upstream.calls[0]).length, DEFAULT_CAP_CHARS);
  } finally {
    upstream.restore();
  }
});

test("no unchanged resend: an upstream timeout is not retried", async () => {
  const upstream = mockUpstream(() => "timeout");
  try {
    const result = await embed(LONG_TEXT, { internalCaller: true });
    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(upstream.calls.length, 1);
  } finally {
    upstream.restore();
  }
});
