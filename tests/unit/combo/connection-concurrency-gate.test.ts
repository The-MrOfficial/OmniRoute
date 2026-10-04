/**
 * tests/unit/combo/connection-concurrency-gate.test.ts
 *
 * #esnixi-5090: the process-global per-connection concurrency slot used by the
 * priority / dispatchSequence / fallback path. These tests pin the contract of
 * acquireConnectionConcurrencySlot against the real semaphore module: `no-limit`
 * when there is no cap, a stable connection-scoped key, genuine serialization
 * (a THIRD concurrent request WAITS when cap=2 — directly modelling the
 * two-combo bug), a `saturated` outcome when the queue is full/timed out, and
 * independent gates per connectionId.
 *
 * HARD CAP (follow-up): acquireConnectionConcurrencySlot no longer decides
 * dispatch-vs-skip. It returns a discriminated outcome and the CALLER maps
 * `saturated` onto fail-open (cloud) or skip-to-next-target (local GPU). These
 * tests pin the outcome shape and the isHardConcurrencyProvider policy helper.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as semaphore from "../../../open-sse/services/rateLimitSemaphore.ts";
import {
  connectionConcurrencyKey,
  acquireConnectionConcurrencySlot,
  isHardConcurrencyProvider,
} from "../../../open-sse/services/combo/connectionConcurrencyGate.ts";

const noopLog = { warn: () => {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("connectionConcurrencyKey is stable and (connection, model)-scoped", () => {
  assert.equal(connectionConcurrencyKey("abc", "m"), "conn:abc:m");
  assert.equal(connectionConcurrencyKey("abc", "m"), connectionConcurrencyKey("abc", "m"));
  assert.notEqual(connectionConcurrencyKey("a", "m"), connectionConcurrencyKey("b", "m"));
  // Same connection + different model → DIFFERENT keys (independent ceilings).
  assert.notEqual(connectionConcurrencyKey("abc", "m1"), connectionConcurrencyKey("abc", "m2"));
});

test("no-limit when cap is null (no per-connection limit → unchanged behavior)", async () => {
  semaphore.resetAll();
  const result = await acquireConnectionConcurrencySlot(
    "c1",
    "m1",
    null,
    { queueTimeoutMs: 50, maxQueueSize: 10 },
    noopLog
  );
  assert.deepEqual(result, { outcome: "no-limit" });
});

test("no-limit when cap <= 0", async () => {
  semaphore.resetAll();
  assert.deepEqual(
    await acquireConnectionConcurrencySlot(
      "c1",
      "m1",
      0,
      { queueTimeoutMs: 50, maxQueueSize: 10 },
      noopLog
    ),
    { outcome: "no-limit" }
  );
  assert.deepEqual(
    await acquireConnectionConcurrencySlot(
      "c1",
      "m1",
      -3,
      { queueTimeoutMs: 50, maxQueueSize: 10 },
      noopLog
    ),
    { outcome: "no-limit" }
  );
});

test("no-limit when connectionId is missing", async () => {
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 50, maxQueueSize: 10 };
  assert.deepEqual(await acquireConnectionConcurrencySlot("", "m1", 1, opts, noopLog), {
    outcome: "no-limit",
  });
  assert.deepEqual(await acquireConnectionConcurrencySlot(null, "m1", 1, opts, noopLog), {
    outcome: "no-limit",
  });
  assert.deepEqual(await acquireConnectionConcurrencySlot(undefined, "m1", 1, opts, noopLog), {
    outcome: "no-limit",
  });
});

test("no-limit when model is missing", async () => {
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 50, maxQueueSize: 10 };
  assert.deepEqual(await acquireConnectionConcurrencySlot("c1", "", 1, opts, noopLog), {
    outcome: "no-limit",
  });
  assert.deepEqual(await acquireConnectionConcurrencySlot("c1", null, 1, opts, noopLog), {
    outcome: "no-limit",
  });
});

test("acquires a slot (outcome=acquired) when a positive cap is set", async () => {
  semaphore.resetAll();
  const result = await acquireConnectionConcurrencySlot(
    "c1",
    "m1",
    1,
    { queueTimeoutMs: 50, maxQueueSize: 10 },
    noopLog
  );
  assert.equal(result.outcome, "acquired");
  assert.equal(typeof (result as { release: () => void }).release, "function");
  (result as { release: () => void }).release();
});

test("cap=2 serializes the THIRD concurrent acquire (two combos share one ceiling)", async () => {
  // Directly models the reported bug: two different combos both admit to the
  // same (connection, model) — the 5090 27B, cap=2. The first two acquire; the
  // THIRD must WAIT until a slot frees, so there are never 3 in flight at once.
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 1000, maxQueueSize: 10 };
  const r1 = await acquireConnectionConcurrencySlot("c1", "m1", 2, opts, noopLog);
  const r2 = await acquireConnectionConcurrencySlot("c1", "m1", 2, opts, noopLog);
  assert.equal(r1.outcome, "acquired", "first combo acquires slot 1 of 2");
  assert.equal(r2.outcome, "acquired", "second combo acquires slot 2 of 2");
  assert.equal(
    semaphore.getStats()[connectionConcurrencyKey("c1", "m1")].running,
    2,
    "2 in flight"
  );

  let thirdResolved = false;
  const p3 = acquireConnectionConcurrencySlot("c1", "m1", 2, opts, noopLog).then((r) => {
    thirdResolved = true;
    return r;
  });

  await wait(60);
  assert.equal(thirdResolved, false, "third acquire waits while 2 slots are held (never 3)");
  assert.equal(
    semaphore.getStats()[connectionConcurrencyKey("c1", "m1")].running,
    2,
    "still only 2 in flight"
  );

  (r1 as { release: () => void }).release(); // free one slot
  const r3 = await p3;
  assert.equal(thirdResolved, true, "third resolves only after a slot frees");
  assert.equal(r3.outcome, "acquired", "third then acquires the freed slot");
  (r2 as { release: () => void }).release();
  (r3 as { release: () => void }).release();
});

test("two different models on ONE connection acquire independent gates (no contention)", async () => {
  // The 4070 Ti bug: a 27B (cap 1) and a 9B share one connection but must NOT
  // share a ceiling. At cap=1 each, both acquire with zero contention.
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 50, maxQueueSize: 0 };
  const rA = await acquireConnectionConcurrencySlot("conn", "model-a", 1, opts, noopLog);
  const rB = await acquireConnectionConcurrencySlot("conn", "model-b", 1, opts, noopLog);
  assert.equal(rA.outcome, "acquired", "model A gets its own slot");
  assert.equal(rB.outcome, "acquired", "model B gets its own slot on the same connection");
  assert.equal(semaphore.getStats()[connectionConcurrencyKey("conn", "model-a")].running, 1);
  assert.equal(semaphore.getStats()[connectionConcurrencyKey("conn", "model-b")].running, 1);
  (rA as { release: () => void }).release();
  (rB as { release: () => void }).release();
});

test("saturated: a full queue reports outcome=saturated (never blocks forever)", async () => {
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 1000, maxQueueSize: 0 };
  const r1 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  assert.equal(r1.outcome, "acquired", "first request acquires");
  const r2 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  assert.equal(
    r2.outcome,
    "saturated",
    "queue full → saturated (caller decides fail-open vs skip)"
  );
  (r1 as { release: () => void }).release();
});

test("saturated on timeout: the bounded wait elapses before reporting saturated", async () => {
  // Deterministic timeout→saturated path: cap 1 held, a short queueTimeoutMs and
  // a non-zero queue so the second acquire WAITS the full window, then times out
  // to `saturated` (it does not fail fast via queue-full).
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 40, maxQueueSize: 10 };
  const r1 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  assert.equal(r1.outcome, "acquired", "first request acquires the only slot");

  const started = Date.now();
  const r2 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  const elapsed = Date.now() - started;
  assert.equal(r2.outcome, "saturated", "the queued acquire times out to saturated");
  assert.ok(elapsed >= 35, `the bounded wait elapsed (${elapsed}ms) before saturated`);
  (r1 as { release: () => void }).release();
});

test("different connections have independent gates (no cross-contention)", async () => {
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 50, maxQueueSize: 0 };
  const r1 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  const r2 = await acquireConnectionConcurrencySlot("c2", "m1", 1, opts, noopLog);
  assert.equal(r1.outcome, "acquired");
  assert.equal(r2.outcome, "acquired", "a different connection has its own slot");
  (r1 as { release: () => void }).release();
  (r2 as { release: () => void }).release();
});

test("release frees the slot for the next waiter", async () => {
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 1000, maxQueueSize: 10 };
  const r1 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  assert.equal(r1.outcome, "acquired");
  assert.equal(semaphore.getStats()[connectionConcurrencyKey("c1", "m1")].running, 1);
  (r1 as { release: () => void }).release();
  const r2 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  assert.equal(r2.outcome, "acquired", "the freed slot is immediately re-acquirable");
  (r2 as { release: () => void }).release();
});

test("isHardConcurrencyProvider: local GPU providers are hard by default", () => {
  assert.equal(isHardConcurrencyProvider("vllm"), true);
  assert.equal(isHardConcurrencyProvider("ollama-local"), true);
  assert.equal(isHardConcurrencyProvider("llama-cpp"), true);
  // Case/space tolerant.
  assert.equal(isHardConcurrencyProvider(" VLLM "), true);
});

test("isHardConcurrencyProvider: cloud/subscription providers fail open (not hard)", () => {
  assert.equal(isHardConcurrencyProvider("openrouter"), false);
  assert.equal(isHardConcurrencyProvider("zai"), false);
  assert.equal(isHardConcurrencyProvider("bedrock"), false);
  assert.equal(isHardConcurrencyProvider(null), false);
  assert.equal(isHardConcurrencyProvider(undefined), false);
  assert.equal(isHardConcurrencyProvider(""), false);
});

test("isHardConcurrencyProvider: OMNIROUTE_HARD_CONCURRENCY_PROVIDERS override is honored", () => {
  const prev = process.env.OMNIROUTE_HARD_CONCURRENCY_PROVIDERS;
  try {
    process.env.OMNIROUTE_HARD_CONCURRENCY_PROVIDERS = "openrouter, custom-gpu";
    assert.equal(isHardConcurrencyProvider("openrouter"), true, "override makes openrouter hard");
    assert.equal(isHardConcurrencyProvider("custom-gpu"), true);
    assert.equal(isHardConcurrencyProvider("vllm"), false, "override replaces the default set");

    // Empty/whitespace override falls back to the local-GPU default.
    process.env.OMNIROUTE_HARD_CONCURRENCY_PROVIDERS = "   ";
    assert.equal(isHardConcurrencyProvider("vllm"), true, "empty override → default set");
  } finally {
    if (prev === undefined) delete process.env.OMNIROUTE_HARD_CONCURRENCY_PROVIDERS;
    else process.env.OMNIROUTE_HARD_CONCURRENCY_PROVIDERS = prev;
  }
});
