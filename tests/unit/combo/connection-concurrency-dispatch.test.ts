/**
 * tests/unit/combo/connection-concurrency-dispatch.test.ts
 *
 * #esnixi-5090: the process-global per-connection ceiling wired into
 * executeTargetAttempt. These tests drive executeTargetAttempt directly (the
 * single chokepoint every priority-path strategy inherits) and assert against
 * the real `conn:<id>` semaphore via semaphore.getStats():
 *
 *   (a) two concurrent dispatches to the SAME connection via two DIFFERENT
 *       combos share one `conn:<id>` ceiling — with cap=2 the third WAITS,
 *       never 3 in flight (the reported bug);
 *   (b) fail-open when no positive cap is set (dispatch proceeds, no slot);
 *   (c) a streaming success releases the slot only AFTER the body stream is
 *       fully consumed, not before;
 *   (d) single-combo behavior: one dispatch acquires and releases exactly once;
 *   (e) strategy === "quota-share" does NOT acquire a `conn:` slot (quota-share
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

test("cap=2: two combos share one conn ceiling — the third dispatch WAITS (never 3)", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-5090-a";
  seedConnection(connectionId, "vllm", 2);
  const key = connectionConcurrencyKey(connectionId);

  // Each dispatch blocks inside handleSingleModel until released, so we can
  // observe how many hold a slot at once. Three dispatches arrive from THREE
  // different "combos" (independent executeTargetAttempt calls) to the SAME
  // connection — exactly the cross-combo scenario that over-admitted the 5090.
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

test("fail-open: no positive cap → dispatch proceeds without a slot", async () => {
  semaphore.resetAll();
  const connectionId = "esnixi-no-cap";
  // Not seeded (or seeded with no positive cap) → lookupPositiveCap returns null.
  const key = connectionConcurrencyKey(connectionId);
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
  const key = connectionConcurrencyKey(connectionId);
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
  const key = connectionConcurrencyKey(connectionId);
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
  const key = connectionConcurrencyKey(connectionId);

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
