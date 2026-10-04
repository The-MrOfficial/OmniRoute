/**
 * tests/unit/combo/connection-concurrency-dispatch.test.ts
 *
 * #esnixi-5090: the process-global per-connection ceiling wired into
 * executeTargetAttempt. These tests drive executeTargetAttempt directly (the
 * single chokepoint every priority-path strategy inherits) and assert against
 * the real `conn:<id>:<model>` semaphore via semaphore.getStats():
 *
 *   (a) two concurrent dispatches to the SAME (connection, model) via two
 *       DIFFERENT combos share one `conn:<id>:<model>` ceiling — with cap=2 the
 *       third WAITS, never 3 in flight (the reported 5090 bug);
 *   (b) per-model split: a per-model override caps model A at 1 WHILE model B on
 *       the same connection runs 4 at once — independent, simultaneous ceilings
 *       (the 4070 Ti bug);
 *   (c) fail-open when no positive cap is set (dispatch proceeds, no slot);
 *   (d) a streaming success releases the slot only AFTER the body stream is
 *       fully consumed, not before;
 *   (e) single-combo behavior: one dispatch acquires and releases exactly once;
 *   (f) strategy === "quota-share" does NOT acquire a `conn:` slot (quota-share
 *       keeps its own `qsconn:` gate — no double-count).
 *
 * The cap is read through the real lookupPositiveCap path, so each connection is
 * seeded into the isolated test SQLite DB (DATA_DIR is per-file isolated).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as semaphore from "../../../open-sse/services/rateLimitSemaphore.ts";
import { connectionConcurrencyKey } from "../../../open-sse/services/combo/connectionConcurrencyGate.ts";
import { executeTargetAttempt } from "../../../open-sse/services/combo/executeTargetAttempt.ts";
import type {
  AttemptLoopDeps,
  AttemptLoopState,
} from "../../../open-sse/services/combo/attemptLoopTypes.ts";
import type { ResolvedComboTarget } from "../../../open-sse/services/combo/types.ts";
import type { HandleSingleModel } from "../../../open-sse/services/combo/types.ts";
import { getDbInstance } from "../../../src/lib/db/core.ts";
import { invalidateDbCache } from "../../../src/lib/db/readCache.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seedConnection(id: string, provider: string, maxConcurrent: number) {
  const db = getDbInstance();
  db.prepare(
    `INSERT OR REPLACE INTO provider_connections
      (id, provider, auth_type, is_active, max_concurrent, created_at, updated_at)
     VALUES (?, ?, 'apikey', 1, ?, datetime('now'), datetime('now'))`
  ).run(id, provider, maxConcurrent);
  // Drop any cached null read so lookupPositiveCap sees the fresh row.
  invalidateDbCache();
}

function emptyState(overrides: Partial<AttemptLoopState> = {}): AttemptLoopState {
  return {
    orderedTargets: [],
    fallbackCount: 0,
    recordedAttempts: 0,
    comboErrors: [],
    lastError: null,
    lastStatus: null,
    earliestRetryAfter: null,
    comboExpired: false,
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
    abortControllers: new Map([[0, new AbortController()]]),
    dispatchedTargets: new Set(),
    targetFailureTrust: new Map(),
    comboAttemptOrder: [],
    skippedForCircuitOpen: false,
    earliestCircuitOpenRetryMs: 0,
    globalAttempts: 0,
    observedFailure: false,
    allObservedFailuresQuota: true,
    observeFailure() {},
    ...overrides,
  };
}

function baseDeps(overrides: Partial<AttemptLoopDeps> = {}): AttemptLoopDeps {
  const handleSingleModelWithTimeout: HandleSingleModel = async () => {
    throw new Error("handleSingleModel must be stubbed");
  };
  return {
    strategy: "priority",
    combo: { name: "t", models: [] },
    config: { queueTimeoutMs: 1000, queueDepth: 10 },
    log: { info() {}, warn() {}, debug() {}, error() {} },
    settings: null,
    resilienceSettings: {
      providerCooldown: { enabled: false },
    } as AttemptLoopDeps["resilienceSettings"],
    sticky: { targets: [], messageHash: null, stuck: false },
    effectiveSessionId: null,
    preScreenMap: new Map(),
    quotaCutoffResetWindowConfig: {} as AttemptLoopDeps["quotaCutoffResetWindowConfig"],
    maxRetries: 0,
    traceInvocationId: "inv-conn-cap",
    clientRequestedStream: false,
    handleSingleModelWithTimeout,
    body: { messages: [{ role: "user", content: "hi" }] },
    startTime: Date.now(),
    releaseStickyPinOnFailure() {},
    clearStaleLKGP() {},
    ...overrides,
  };
}

function modelTarget(overrides: Partial<ResolvedComboTarget> = {}): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: "s1",
    executionKey: "ek-1",
    modelStr: "vllm/qwen3.8-27b-nvfp4",
    provider: "vllm",
    providerId: null,
    connectionId: "esnixi-5090",
    weight: 1,
    label: null,
    ...overrides,
  };
}

function json200(connectionId: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-omniroute-selected-connection-id": connectionId,
    },
  });
}

function runAttempt(deps: AttemptLoopDeps, target: ResolvedComboTarget) {
  const state = emptyState({
    orderedTargets: [target],
    abortControllers: new Map([[0, new AbortController()]]),
  });
  return executeTargetAttempt({
    index: 0,
    state,
    deps,
    targetForAttempt: target,
    profile: {},
    protectedPriorityTarget: false,
  });
}

/**
 * Run executeTargetAttempt for a chosen ordered-target INDEX, returning both the
 * result and the shared state so a test can inspect fallbackCount after a skip.
 * `orderedTargets` carries ≥2 entries so a skip at index 0 models "overflow to
 * the next target" and an attempt at index 1 models the next target dispatching.
 */
function runAttemptAt(deps: AttemptLoopDeps, orderedTargets: ResolvedComboTarget[], index: number) {
  const abortControllers = new Map<number, AbortController>();
  orderedTargets.forEach((_, i) => abortControllers.set(i, new AbortController()));
  const state = emptyState({ orderedTargets, abortControllers });
  const result = executeTargetAttempt({
    index,
    state,
    deps,
    targetForAttempt: orderedTargets[index],
    profile: {},
    protectedPriorityTarget: false,
  });
  return { result, state };
}

const MODEL_5090_27B = "vllm/qwen3.8-27b-nvfp4";
const MODEL_4070_27B = "ollama-local/qwen3.8:27b-iq3-code144k";
const MODEL_4070_9B = "ollama-local/qwen3.5-reader:9b";

test("cap=2: two combos share one (conn, model) ceiling — the third dispatch WAITS (never 3)", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-5090-a";
  seedConnection(connectionId, "vllm", 2);
  const key = connectionConcurrencyKey(connectionId, MODEL_5090_27B);

  // Each dispatch blocks inside handleSingleModel until released, so we can
  // observe how many hold a slot at once. Three dispatches arrive from THREE
  // different "combos" (independent executeTargetAttempt calls) to the SAME
  // (connection, model) — exactly the cross-combo scenario that over-admitted
  // the 5090.
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const target = modelTarget({ connectionId });
  const deps = baseDeps({
    handleSingleModelWithTimeout: async () => {
      await gate;
      return json200(connectionId);
    },
  });

  const p1 = runAttempt(deps, target);
  const p2 = runAttempt(deps, target);
  const p3 = runAttempt(deps, target);

  await wait(80);
  assert.equal(
    semaphore.getStats()[key]?.running,
    2,
    "cap=2 → exactly two dispatches in flight, the third is queued (never 3)"
  );
  assert.equal(semaphore.getStats()[key]?.queued, 1, "the third dispatch waits in the queue");

  releaseGate!();
  const results = await Promise.all([p1, p2, p3]);
  for (const r of results) assert.equal(r?.ok, true, "every dispatch eventually succeeds");
  assert.equal(semaphore.getStats()[key], undefined, "all slots released after completion");
});

test("per-model split: A (override cap 1) ≤ 1 WHILE B (connection cap 4) runs 4 at once", async () => {
  // The core 4070 Ti regression. ONE connection, cap 4. Model A (the 27B coder)
  // carries a per-model override of 1 via weightedTargetPolicies; model B (the
  // 9B reader) has no override and inherits the connection cap of 4. The two
  // ceilings must be enforced INDEPENDENTLY and SIMULTANEOUSLY — A never exceeds
  // 1 while B runs 4 at the same instant.
  semaphore.resetAll();
  const connectionId = "gremlin-4070ti";
  seedConnection(connectionId, "ollama-local", 4);
  const keyA = connectionConcurrencyKey(connectionId, MODEL_4070_27B);
  const keyB = connectionConcurrencyKey(connectionId, MODEL_4070_9B);

  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const deps = baseDeps({
    combo: {
      name: "split",
      models: [],
      config: { weightedTargetPolicies: { [MODEL_4070_27B]: { maxConcurrent: 1 } } },
    },
    handleSingleModelWithTimeout: async () => {
      await gate;
      return json200(connectionId);
    },
  });
  const targetA = modelTarget({ connectionId, modelStr: MODEL_4070_27B, provider: "ollama-local" });
  const targetB = modelTarget({
    connectionId,
    modelStr: MODEL_4070_9B,
    provider: "ollama-local",
    executionKey: "ek-b",
  });

  // Fire 2× A and 4× B concurrently; all hold the shared gate.
  const pA = [runAttempt(deps, targetA), runAttempt(deps, targetA)];
  const pB = [
    runAttempt(deps, targetB),
    runAttempt(deps, targetB),
    runAttempt(deps, targetB),
    runAttempt(deps, targetB),
  ];

  await wait(80);
  assert.equal(
    semaphore.getStats()[keyA]?.running,
    1,
    "A capped at 1 (per-model override beats conn cap 4)"
  );
  assert.equal(semaphore.getStats()[keyA]?.queued, 1, "the second A waits");
  assert.equal(
    semaphore.getStats()[keyB]?.running,
    4,
    "B runs 4 at the SAME instant (connection cap 4, independent of A)"
  );

  releaseGate!();
  const results = await Promise.all([...pA, ...pB]);
  for (const r of results) assert.equal(r?.ok, true, "every dispatch eventually succeeds");
  assert.equal(semaphore.getStats()[keyA], undefined, "A key drains");
  assert.equal(semaphore.getStats()[keyB], undefined, "B key drains");
});

test("5090 27B ≤ 2 across two DIFFERENT combos (never 3)", async () => {
  semaphore.resetAll();
  const connectionId = "e9bd13fb";
  seedConnection(connectionId, "vllm", 2);
  const key = connectionConcurrencyKey(connectionId, MODEL_5090_27B);

  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const target = modelTarget({ connectionId, modelStr: MODEL_5090_27B });
  // Two different combo names, same (connection, model), no per-model override.
  const depsA = baseDeps({
    combo: { name: "comboA", models: [] },
    handleSingleModelWithTimeout: async () => {
      await gate;
      return json200(connectionId);
    },
  });
  const depsB = baseDeps({
    combo: { name: "comboB", models: [] },
    handleSingleModelWithTimeout: async () => {
      await gate;
      return json200(connectionId);
    },
  });

  const p1 = runAttempt(depsA, target);
  const p2 = runAttempt(depsB, target);
  const p3 = runAttempt(depsA, target);

  await wait(80);
  assert.equal(semaphore.getStats()[key]?.running, 2, "5090 27B stays at 2 across two combos");
  assert.equal(semaphore.getStats()[key]?.queued, 1, "the third waits (never 3)");

  releaseGate!();
  const results = await Promise.all([p1, p2, p3]);
  for (const r of results) assert.equal(r?.ok, true, "every dispatch eventually succeeds");
  assert.equal(semaphore.getStats()[key], undefined, "all slots released after completion");
});

test("per-model override of 1 beats a connection cap of 4", async () => {
  // Dedicated single-model assertion: connection cap 4, override 1 → caps at 1.
  semaphore.resetAll();
  const connectionId = "gremlin-override";
  seedConnection(connectionId, "ollama-local", 4);
  const key = connectionConcurrencyKey(connectionId, MODEL_4070_27B);

  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const deps = baseDeps({
    combo: {
      name: "override",
      models: [],
      config: { weightedTargetPolicies: { [MODEL_4070_27B]: { maxConcurrent: 1 } } },
    },
    handleSingleModelWithTimeout: async () => {
      await gate;
      return json200(connectionId);
    },
  });
  const target = modelTarget({ connectionId, modelStr: MODEL_4070_27B, provider: "ollama-local" });

  const p1 = runAttempt(deps, target);
  const p2 = runAttempt(deps, target);

  await wait(80);
  assert.equal(semaphore.getStats()[key]?.running, 1, "override 1 caps the 27B at 1, not 4");
  assert.equal(semaphore.getStats()[key]?.queued, 1, "the second waits");

  releaseGate!();
  const results = await Promise.all([p1, p2]);
  for (const r of results) assert.equal(r?.ok, true);
  assert.equal(semaphore.getStats()[key], undefined, "slots released after completion");
});

test("fail-open: no positive cap → dispatch proceeds without a slot", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-no-cap";
  // Not seeded (or seeded with no positive cap) → lookupPositiveCap returns null.
  const key = connectionConcurrencyKey(connectionId, MODEL_5090_27B);
  const target = modelTarget({ connectionId });
  const deps = baseDeps({
    handleSingleModelWithTimeout: async () => json200(connectionId),
  });
  const result = await runAttempt(deps, target);
  assert.equal(result?.ok, true, "dispatch proceeds when there is no cap");
  assert.equal(semaphore.getStats()[key], undefined, "no gate was ever created (no slot taken)");
});

test("single combo: one dispatch acquires and releases the slot exactly once", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-5090-single";
  seedConnection(connectionId, "vllm", 2);
  const key = connectionConcurrencyKey(connectionId, MODEL_5090_27B);
  const target = modelTarget({ connectionId });
  const deps = baseDeps({
    handleSingleModelWithTimeout: async () => json200(connectionId),
  });
  const result = await runAttempt(deps, target);
  assert.equal(result?.ok, true);
  assert.equal(
    semaphore.getStats()[key],
    undefined,
    "a non-streaming success releases its slot immediately"
  );
});

test("streaming success: slot is held until the body stream is fully consumed", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-5090-stream";
  seedConnection(connectionId, "vllm", 2);
  const key = connectionConcurrencyKey(connectionId, MODEL_5090_27B);
  const target = modelTarget({ connectionId });

  // A minimal SSE stream the quality check will treat as valid content.
  const encoder = new TextEncoder();
  const makeStream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`)
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

  const deps = baseDeps({
    clientRequestedStream: true,
    handleSingleModelWithTimeout: async () =>
      new Response(makeStream(), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-omniroute-selected-connection-id": connectionId,
        },
      }),
  });

  const result = await runAttempt(deps, target);
  assert.equal(result?.ok, true);
  // The slot must STILL be held: the gated body has not been read yet.
  assert.equal(
    semaphore.getStats()[key]?.running,
    1,
    "slot stays held while the stream body is unconsumed (model may still be generating)"
  );

  // Drain the returned body fully; only then should the slot free.
  const reader = (result!.response!.body as ReadableStream<Uint8Array>).getReader();
  let text = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  assert.match(text, /\[DONE\]/, "the forwarded body contains the full upstream stream");
  await wait(10);
  assert.equal(
    semaphore.getStats()[key],
    undefined,
    "slot is released only AFTER the stream is fully consumed"
  );
});

test("quota-share does NOT acquire a conn: slot (keeps its own qsconn: gate, no double-count)", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-5090-qs";
  seedConnection(connectionId, "vllm", 2);
  const key = connectionConcurrencyKey(connectionId, MODEL_5090_27B);

  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const target = modelTarget({ connectionId });
  const deps = baseDeps({
    strategy: "quota-share",
    handleSingleModelWithTimeout: async () => {
      await gate;
      return json200(connectionId);
    },
  });

  const p = runAttempt(deps, target);
  await wait(60);
  assert.equal(
    semaphore.getStats()[key],
    undefined,
    "quota-share must not touch the conn: gate (its qsconn: gate lives in combo.ts)"
  );
  releaseGate!();
  const result = await p;
  assert.equal(result?.ok, true);
});

const MODEL_GLM = "zai/glm-5.3";

/**
 * HARD CAP (follow-up): for a local GPU provider the per-(connection, model)
 * ceiling is a HARD cap. When a slot cannot be acquired within the queue window,
 * the request must NOT be dispatched to that target — it SKIPS to the next
 * ordered target (overflow), the shared semaphore never exceeds the cap even at
 * timeout, and the saturated model's handleSingleModel is never invoked for the
 * over-cap request.
 */
test("HARD cap (vllm): cap=2, 3rd dispatch TIMES OUT and SKIPS to next target (never 3, no dispatch-anyway)", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-5090-hard";
  seedConnection(connectionId, "vllm", 2);
  const key = connectionConcurrencyKey(connectionId, MODEL_5090_27B);

  // The two holders block inside handleSingleModel; the 3rd must time out on the
  // gate (short queueTimeoutMs, queue deep enough to WAIT not fail-fast) and skip
  // BEFORE handleSingleModel — so it never dispatches to the saturated model.
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  let maxConcurrentHandle = 0;
  let liveHandle = 0;
  let handleCalls = 0;
  const makeDeps = (name: string) =>
    baseDeps({
      // Short queue timeout + a non-zero queue so the 3rd WAITS then times out
      // (the real timeout→skip path, not an instant queue-full fail).
      config: { queueTimeoutMs: 50, queueDepth: 5 },
      combo: { name, models: [] },
      handleSingleModelWithTimeout: async () => {
        handleCalls++;
        liveHandle++;
        maxConcurrentHandle = Math.max(maxConcurrentHandle, liveHandle);
        try {
          await gate;
          return json200(connectionId);
        } finally {
          liveHandle--;
        }
      },
    });

  const target = modelTarget({ connectionId, modelStr: MODEL_5090_27B, provider: "vllm" });
  // Two holders from two different combos.
  const p1 = runAttempt(makeDeps("comboA"), target);
  const p2 = runAttempt(makeDeps("comboB"), target);
  await wait(20);
  assert.equal(semaphore.getStats()[key]?.running, 2, "two holders in flight");

  // The 3rd arrives with a next target available: index 0 is the saturated 5090,
  // index 1 is GLM (the overflow target). The hard cap must skip index 0.
  const next = modelTarget({
    connectionId: "glm-conn",
    modelStr: MODEL_GLM,
    provider: "zai",
    executionKey: "ek-glm",
  });
  const { result: thirdResult, state: thirdState } = runAttemptAt(
    makeDeps("comboC"),
    [target, next],
    0
  );
  const third = await thirdResult;

  assert.equal(third, null, "the 3rd attempt SKIPS (returns null) — overflow to next target");
  assert.equal(
    semaphore.getStats()[key]?.running,
    2,
    "the shared semaphore NEVER exceeds the cap of 2, even at timeout"
  );
  assert.ok(
    maxConcurrentHandle <= 2,
    `handleSingleModel never ran more than 2 at once (saw ${maxConcurrentHandle})`
  );
  assert.equal(handleCalls, 2, "the 3rd request did NOT dispatch to the saturated model");
  assert.equal(thirdState.fallbackCount, 0, "a skip at index 0 does not bump fallbackCount");

  releaseGate!();
  const results = await Promise.all([p1, p2]);
  for (const r of results) assert.equal(r?.ok, true, "the two holders still succeed");
  assert.equal(semaphore.getStats()[key], undefined, "all slots released");
});

test("HARD cap: a skip at a FALLBACK index (i>0) bumps fallbackCount and the next target still dispatches", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-5090-hard-fb";
  seedConnection(connectionId, "vllm", 1);
  const key = connectionConcurrencyKey(connectionId, MODEL_5090_27B);

  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const makeDeps = (name: string) =>
    baseDeps({
      config: { queueTimeoutMs: 50, queueDepth: 5 },
      combo: { name, models: [] },
      handleSingleModelWithTimeout: async () => {
        await gate;
        return json200(connectionId);
      },
    });

  const saturated = modelTarget({ connectionId, modelStr: MODEL_5090_27B, provider: "vllm" });
  // Hold the single slot.
  const holder = runAttempt(makeDeps("holder"), saturated);
  await wait(20);
  assert.equal(semaphore.getStats()[key]?.running, 1, "the only slot is held");

  // A fallback chain where the saturated 5090 is at index 1 (i>0): skipping it
  // must bump fallbackCount, modelling overflow deeper in the chain.
  const primary = modelTarget({
    connectionId: "primary-conn",
    modelStr: "vllm/other-model",
    provider: "vllm",
    executionKey: "ek-primary",
  });
  const { result, state } = runAttemptAt(makeDeps("fbcombo"), [primary, saturated], 1);
  const skipped = await result;

  assert.equal(skipped, null, "the saturated fallback target SKIPS");
  assert.equal(state.fallbackCount, 1, "a skip at i>0 bumps fallbackCount (overflow accounting)");

  releaseGate!();
  await holder;
  assert.equal(semaphore.getStats()[key], undefined, "slot released");
});

/**
 * Non-hard providers keep the historical FAIL-OPEN: on saturation they dispatch
 * anyway (availability is never worsened for cloud/subscription targets).
 */
test("FAIL-OPEN (cloud): a non-hard provider still dispatches on saturation", async () => {
  semaphore.resetAll();
  const connectionId = "openrouter-conn";
  seedConnection(connectionId, "openrouter", 2);
  const key = connectionConcurrencyKey(connectionId, MODEL_GLM);

  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  let handleCalls = 0;
  const makeDeps = (name: string) =>
    baseDeps({
      config: { queueTimeoutMs: 50, queueDepth: 5 },
      combo: { name, models: [] },
      handleSingleModelWithTimeout: async () => {
        handleCalls++;
        await gate;
        return json200(connectionId);
      },
    });
  const target = modelTarget({ connectionId, modelStr: MODEL_GLM, provider: "openrouter" });

  // Fill the cap with two holders.
  const p1 = runAttempt(makeDeps("c1"), target);
  const p2 = runAttempt(makeDeps("c2"), target);
  await wait(20);
  assert.equal(semaphore.getStats()[key]?.running, 2, "two holders fill the cloud cap");

  // The 3rd saturates the gate but, being a cloud provider, FAILS OPEN: it must
  // dispatch anyway (handleSingleModel is invoked a 3rd time).
  const p3 = runAttempt(makeDeps("c3"), target);
  await wait(120); // > queueTimeoutMs so the gate times out and fail-open fires
  assert.equal(
    handleCalls,
    3,
    "cloud provider dispatches the 3rd request on saturation (fail-open)"
  );

  releaseGate!();
  const results = await Promise.all([p1, p2, p3]);
  for (const r of results) assert.equal(r?.ok, true, "all three cloud dispatches succeed");
});

/**
 * All targets saturated/exhausted must surface as the normal combo-exhausted
 * outcome (a skip/null that the outer loop turns into a retryable error), NOT a
 * dispatch-anyway and NOT a crash.
 */
test("HARD cap all-saturated: the only hard target skips (null) — no dispatch, no crash", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-5090-exhausted";
  seedConnection(connectionId, "vllm", 1);
  const key = connectionConcurrencyKey(connectionId, MODEL_5090_27B);

  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  let handleCalls = 0;
  const makeDeps = (name: string) =>
    baseDeps({
      config: { queueTimeoutMs: 50, queueDepth: 5 },
      combo: { name, models: [] },
      handleSingleModelWithTimeout: async () => {
        handleCalls++;
        await gate;
        return json200(connectionId);
      },
    });
  const target = modelTarget({ connectionId, modelStr: MODEL_5090_27B, provider: "vllm" });

  // Hold the only slot, then fire the over-cap request against a SINGLE-target
  // chain (no overflow target) — it must skip (null) without dispatching.
  const holder = runAttempt(makeDeps("holder"), target);
  await wait(20);
  const over = await runAttempt(makeDeps("over"), target);

  assert.equal(
    over,
    null,
    "all-saturated → skip (null) so the outer loop surfaces combo-exhausted"
  );
  assert.equal(handleCalls, 1, "only the holder dispatched; the over-cap request never did");
  assert.equal(semaphore.getStats()[key]?.running, 1, "cap never exceeded");

  releaseGate!();
  await holder;
  assert.equal(semaphore.getStats()[key], undefined, "slot released after the holder completes");
});
