// #13601.3: a failed memory vector embedding write must be retried once
// before it is logged and queued for reindex — a single transient failure
// (slow potion load, brief remote 5xx) should not silently skip vectorization.
import { test } from "node:test";
import assert from "node:assert/strict";

const { embedWithRetry } = await import("../../src/lib/memory/embedding/index.ts");

type EmbedResult = { vector: number[] } | { reason: string; message: string };

const settings = {} as Parameters<typeof embedWithRetry>[1];

test("#13601.3: success on the first attempt performs exactly one embed", async () => {
  let calls = 0;
  const result = (await embedWithRetry("hello", settings, async () => {
    calls += 1;
    return { vector: [1, 2, 3] };
  })) as EmbedResult;
  assert.equal(calls, 1);
  assert.ok("vector" in result);
});

test("#13601.3: a transient first failure is retried and can still succeed", async () => {
  let calls = 0;
  const result = (await embedWithRetry("hello", settings, async () => {
    calls += 1;
    if (calls === 1) return { reason: "request_failed", message: "boom" };
    return { vector: [1, 2, 3] };
  })) as EmbedResult;
  assert.equal(calls, 2);
  assert.ok("vector" in result);
});

test("#13601.3: a persistent failure surfaces the last error after one retry", async () => {
  let calls = 0;
  const result = (await embedWithRetry("hello", settings, async () => {
    calls += 1;
    return { reason: "request_failed", message: `boom-${calls}` };
  })) as EmbedResult;
  assert.equal(calls, 2);
  assert.ok(!("vector" in result));
  if (!("vector" in result)) assert.equal(result.message, "boom-2");
});

// A timeout or 5xx may be a poison input that wedges the embed server; resending it at once
// would wedge it again, so embedWithRetry returns immediately and the reindex sweep retries.
async function countCalls(failure: { reason: string; message: string; status?: number }) {
  let calls = 0;
  const result = (await embedWithRetry("hello", settings, async () => {
    calls += 1;
    return failure;
  })) as EmbedResult;
  assert.ok(!("vector" in result));
  return calls;
}

test("embedWithRetry: a timeout is not resent", async () => {
  assert.equal(await countCalls({ reason: "timeout", message: "slow" }), 1);
});

test("embedWithRetry: a 5xx is not resent", async () => {
  assert.equal(await countCalls({ reason: "request_failed", message: "boom", status: 503 }), 1);
});

test("embedWithRetry: a rate limit still gets one retry", async () => {
  assert.equal(await countCalls({ reason: "rate_limited", message: "429", status: 429 }), 2);
});

test("embedWithRetry: a 4xx still gets one retry", async () => {
  // Existing behavior: a 4xx is deterministic, so the single retry is harmless.
  assert.equal(await countCalls({ reason: "request_failed", message: "bad", status: 400 }), 2);
});
