/**
 * tests/unit/combo/connection-concurrency-gate.test.ts
 *
 * #esnixi-5090: the process-global per-connection concurrency slot used by the
 * priority / dispatchSequence / fallback path. These tests pin the contract of
 * acquireConnectionConcurrencySlot against the real semaphore module: no limit
 * when there is no cap, a stable connection-scoped key, genuine serialization
 * (a THIRD concurrent request WAITS when cap=2 — directly modelling the
 * two-combo bug), fail-open when the queue is saturated, and independent gates
 * per connectionId.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as semaphore from "../../../open-sse/services/rateLimitSemaphore.ts";
import {
  connectionConcurrencyKey,
  acquireConnectionConcurrencySlot,
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

test("no slot when cap is null (no per-connection limit → unchanged behavior)", async () => {
  semaphore.resetAll();
  const release = await acquireConnectionConcurrencySlot(
    "c1",
    "m1",
    null,
    { queueTimeoutMs: 50, maxQueueSize: 10 },
    noopLog
  );
  assert.equal(release, null);
});

test("no slot when cap <= 0", async () => {
  semaphore.resetAll();
  assert.equal(
    await acquireConnectionConcurrencySlot(
      "c1",
      "m1",
      0,
      { queueTimeoutMs: 50, maxQueueSize: 10 },
      noopLog
    ),
    null
  );
  assert.equal(
    await acquireConnectionConcurrencySlot(
      "c1",
      "m1",
      -3,
      { queueTimeoutMs: 50, maxQueueSize: 10 },
      noopLog
    ),
    null
  );
});

test("no slot when connectionId is missing", async () => {
  semaphore.resetAll();
  assert.equal(
    await acquireConnectionConcurrencySlot(
      "",
      "m1",
      1,
      { queueTimeoutMs: 50, maxQueueSize: 10 },
      noopLog
    ),
    null
  );
  assert.equal(
    await acquireConnectionConcurrencySlot(
      null,
      "m1",
      1,
      { queueTimeoutMs: 50, maxQueueSize: 10 },
      noopLog
    ),
    null
  );
  assert.equal(
    await acquireConnectionConcurrencySlot(
      undefined,
      "m1",
      1,
      { queueTimeoutMs: 50, maxQueueSize: 10 },
      noopLog
    ),
    null
  );
});

test("no slot when model is missing", async () => {
  semaphore.resetAll();
  assert.equal(
    await acquireConnectionConcurrencySlot(
      "c1",
      "",
      1,
      { queueTimeoutMs: 50, maxQueueSize: 10 },
      noopLog
    ),
    null
  );
  assert.equal(
    await acquireConnectionConcurrencySlot(
      "c1",
      null,
      1,
      { queueTimeoutMs: 50, maxQueueSize: 10 },
      noopLog
    ),
    null
  );
});

test("acquires a slot when a positive cap is set", async () => {
  semaphore.resetAll();
  const release = await acquireConnectionConcurrencySlot(
    "c1",
    "m1",
    1,
    { queueTimeoutMs: 50, maxQueueSize: 10 },
    noopLog
  );
  assert.equal(typeof release, "function");
  release!();
});

test("cap=2 serializes the THIRD concurrent acquire (two combos share one ceiling)", async () => {
  // Directly models the reported bug: two different combos both admit to the
  // same (connection, model) — the 5090 27B, cap=2. The first two acquire; the
  // THIRD must WAIT until a slot frees, so there are never 3 in flight at once.
  // All three use the SAME (conn, model) — the two-combos-sharing-one-ceiling case.
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 1000, maxQueueSize: 10 };
  const r1 = await acquireConnectionConcurrencySlot("c1", "m1", 2, opts, noopLog);
  const r2 = await acquireConnectionConcurrencySlot("c1", "m1", 2, opts, noopLog);
  assert.equal(typeof r1, "function", "first combo acquires slot 1 of 2");
  assert.equal(typeof r2, "function", "second combo acquires slot 2 of 2");
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

  r1!(); // free one slot
  const r3 = await p3;
  assert.equal(thirdResolved, true, "third resolves only after a slot frees");
  assert.equal(typeof r3, "function", "third then acquires the freed slot");
  r2!();
  r3!();
});

test("two different models on ONE connection acquire independent gates (no contention)", async () => {
  // The 4070 Ti bug: a 27B (cap 1) and a 9B share one connection but must NOT
  // share a ceiling. At cap=1 each, both acquire with zero contention.
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 50, maxQueueSize: 0 };
  const rA = await acquireConnectionConcurrencySlot("conn", "model-a", 1, opts, noopLog);
  const rB = await acquireConnectionConcurrencySlot("conn", "model-b", 1, opts, noopLog);
  assert.equal(typeof rA, "function", "model A gets its own slot");
  assert.equal(typeof rB, "function", "model B gets its own slot on the same connection");
  assert.equal(semaphore.getStats()[connectionConcurrencyKey("conn", "model-a")].running, 1);
  assert.equal(semaphore.getStats()[connectionConcurrencyKey("conn", "model-b")].running, 1);
  rA!();
  rB!();
});

test("fail-open: a saturated queue proceeds without a slot (null), never blocks", async () => {
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 1000, maxQueueSize: 0 };
  const r1 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  assert.equal(typeof r1, "function", "first request acquires");
  const r2 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  assert.equal(r2, null, "queue full → fail-open null (availability never worsened)");
  r1!();
});

test("different connections have independent gates (no cross-contention)", async () => {
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 50, maxQueueSize: 0 };
  const r1 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  const r2 = await acquireConnectionConcurrencySlot("c2", "m1", 1, opts, noopLog);
  assert.equal(typeof r1, "function");
  assert.equal(typeof r2, "function", "a different connection has its own slot");
  r1!();
  r2!();
});

test("release frees the slot for the next waiter", async () => {
  semaphore.resetAll();
  const opts = { queueTimeoutMs: 1000, maxQueueSize: 10 };
  const r1 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  assert.equal(semaphore.getStats()[connectionConcurrencyKey("c1", "m1")].running, 1);
  r1!();
  const r2 = await acquireConnectionConcurrencySlot("c1", "m1", 1, opts, noopLog);
  assert.equal(typeof r2, "function", "the freed slot is immediately re-acquirable");
  r2!();
});
