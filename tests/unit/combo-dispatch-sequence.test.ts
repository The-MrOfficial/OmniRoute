/**
 * @file combo-dispatch-sequence.test.ts
 * @description Unit coverage for `config.dispatchSequence` ordered dispatch on
 * `priority` combos (OmniRoute ordered-dispatch feature).
 *
 * Proves:
 *   A. Four simultaneous jobs against a sequence [5090a, 4070ti, 5090b, glm]
 *      interleave in exact order 5090 → 4070Ti → 5090 → GLM. Each concurrent
 *      request starts at the next sequence entry because the per-combo cursor
 *      advances at admission (rotation time), not at settle.
 *   B. A sequence head that is at the per-connection concurrency cap is SKIPPED
 *      to the next entry (fail-safe), and when the entire sequence is at
 *      capacity the request falls through to a tier-2 fallback target rather
 *      than stalling or erroring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-dispatch-seq-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { dispatchSeqCounters, rrStickyTargets, weightedStickyTargets } =
  await import("../../open-sse/services/combo/rrState.ts");
const {
  acquire,
  buildAccountSemaphoreKey,
  resetAll: resetAllAccountSemaphores,
} = await import("../../open-sse/services/accountSemaphore.ts");
const { resetAll: resetAllRateLimitSemaphores } =
  await import("../../open-sse/services/rateLimitSemaphore.ts");
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");

// Connection ids modelled on the live tier-1 pool (names only matter for the
// per-connection semaphore key; the two 5090 steps SHARE one connection id so a
// single `maxConcurrent=2` semaphore gates both of its slots).
const CONN_5090 = "conn-5090-vllm";
const CONN_4070TI = "conn-4070ti-ollama";
const CONN_GLM = "conn-glm-llamacpp";
const CONN_TIER2 = "conn-tier2-fallback";

const MODEL_5090 = "vllm/qwen3-27b-nvfp4";
const MODEL_4070TI = "ollama-local/qwen3:27b-iq3";
const MODEL_GLM = "llama-cpp/ds-glm53";
const MODEL_TIER2 = "openrouter/qwen/qwen3-27b:free";

function createLog() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function okResponse() {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function seedConnection(id: string, provider: string, maxConcurrent: number) {
  const db = getDbInstance();
  db.prepare(
    `INSERT OR REPLACE INTO provider_connections
      (id, provider, auth_type, is_active, max_concurrent, created_at, updated_at)
     VALUES (?, ?, 'apikey', 1, ?, datetime('now'), datetime('now'))`
  ).run(id, provider, maxConcurrent);
  // The combo cap lookup goes through getCachedProviderConnectionById; bust the
  // read cache so a cap written by a prior test cannot leak into this one.
  invalidateDbCache("connections", id);
}

/** A dispatch handler that records the (modelStr, connectionId) and blocks until released. */
function makeBlockingHandler() {
  const dispatched: Array<{ modelStr: string; connectionId: string | null }> = [];
  const releases: Array<() => void> = [];
  const handleSingleModel = async (
    _body: Record<string, unknown>,
    modelStr: string,
    target?: { connectionId?: string | null }
  ) => {
    dispatched.push({ modelStr, connectionId: target?.connectionId ?? null });
    await new Promise<void>((resolve) => releases.push(resolve));
    return okResponse();
  };
  const releaseAll = () => {
    for (const release of releases.splice(0)) release();
  };
  return { dispatched, handleSingleModel, releaseAll };
}

function tier1Combo(name: string) {
  return {
    name,
    strategy: "priority",
    models: [
      { kind: "model", id: `${name}-5090a`, model: MODEL_5090, connectionId: CONN_5090 },
      { kind: "model", id: `${name}-4070ti`, model: MODEL_4070TI, connectionId: CONN_4070TI },
      { kind: "model", id: `${name}-5090b`, model: MODEL_5090, connectionId: CONN_5090 },
      { kind: "model", id: `${name}-glm`, model: MODEL_GLM, connectionId: CONN_GLM },
    ],
    config: {
      maxRetries: 0,
      retryDelayMs: 0,
      fallbackDelayMs: 0,
      dispatchSequence: [`${name}-5090a`, `${name}-4070ti`, `${name}-5090b`, `${name}-glm`],
    },
  };
}

test.beforeEach(() => {
  dispatchSeqCounters.clear();
  rrStickyTargets.clear();
  weightedStickyTargets.clear();
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllAccountSemaphores();
  resetAllRateLimitSemaphores();
  invalidateDbCache("connections");
});

test.after(() => {
  dispatchSeqCounters.clear();
  resetAllAccountSemaphores();
  resetAllRateLimitSemaphores();
  resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("four simultaneous jobs interleave 5090 -> 4070Ti -> 5090 -> GLM", async () => {
  seedConnection(CONN_5090, "vllm", 2);
  seedConnection(CONN_4070TI, "ollama-local", 1);
  seedConnection(CONN_GLM, "llama-cpp", 1);

  const combo = tier1Combo("t1-interleave");
  const { dispatched, handleSingleModel, releaseAll } = makeBlockingHandler();

  // Admit the four jobs one at a time, each one landing (and holding its
  // blocking slot) before the next is admitted. The per-combo cursor advances
  // at admission, so job N starts at sequence entry N. All four stay in flight
  // (the handler never resolves until releaseAll), so this is four simultaneous
  // jobs — serialized only at the admission boundary to make the per-job
  // assignment deterministic rather than racing the pre-dispatch await chain.
  const jobs: Array<Promise<{ ok: boolean }>> = [];
  for (let jobIndex = 0; jobIndex < 4; jobIndex += 1) {
    jobs.push(
      handleComboChat({
        body: {},
        combo,
        handleSingleModel,
        isModelAvailable: async () => true,
        log: createLog(),
        settings: null,
        allCombos: [combo],
      })
    );
    // Wait until this job has reached (and is blocked in) its dispatch target.
    const expectedCount = jobIndex + 1;
    const deadline = Date.now() + 2000;
    while (dispatched.length < expectedCount && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      dispatched.length,
      expectedCount,
      `job ${expectedCount} must reach dispatch before the next is admitted`
    );
  }

  const landedConnections = dispatched.map((d) => d.connectionId);
  assert.deepEqual(
    landedConnections,
    [CONN_5090, CONN_4070TI, CONN_5090, CONN_GLM],
    "dispatch order must be 5090, 4070Ti, 5090, GLM"
  );

  releaseAll();
  const results = await Promise.all(jobs);
  for (const result of results) assert.equal(result.ok, true);
});

test("a sequence head at capacity is skipped to the next entry (fail-safe)", async () => {
  seedConnection(CONN_5090, "vllm", 2);
  seedConnection(CONN_4070TI, "ollama-local", 1);
  seedConnection(CONN_GLM, "llama-cpp", 1);

  // Hold the single 4070 Ti slot so its connection reports at-capacity.
  const release4070 = await acquire(
    buildAccountSemaphoreKey({ provider: "ollama-local", accountKey: CONN_4070TI }),
    { maxConcurrency: 1 }
  );

  // Pre-advance the cursor so this single job's rotated head is the 4070 Ti step.
  dispatchSeqCounters.set("t1-skip", 1);

  try {
    const combo = tier1Combo("t1-skip");
    const calls: Array<{ modelStr: string; connectionId: string | null }> = [];
    const result = await handleComboChat({
      body: {},
      combo,
      handleSingleModel: async (_body, modelStr, target?: { connectionId?: string | null }) => {
        calls.push({ modelStr, connectionId: target?.connectionId ?? null });
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: [combo],
    });

    assert.equal(result.ok, true, "request must still dispatch to a live target");
    assert.equal(calls.length, 1, "the at-capacity head is skipped, not dispatched");
    assert.notEqual(
      calls[0].connectionId,
      CONN_4070TI,
      "the at-capacity 4070 Ti head must be skipped"
    );
    // Rotated order from cursor=1 is [4070ti, 5090b, glm, 5090a]; skipping the
    // 4070 Ti lands on the next entry, the second 5090 step.
    assert.equal(calls[0].connectionId, CONN_5090, "skip advances to the next sequence entry");
  } finally {
    release4070();
  }
});

test("whole sequence at capacity falls through to the tier-2 fallback target", async () => {
  seedConnection(CONN_5090, "vllm", 1);
  seedConnection(CONN_4070TI, "ollama-local", 1);
  seedConnection(CONN_GLM, "llama-cpp", 1);
  seedConnection(CONN_TIER2, "openrouter", 1);

  // Saturate every tier-1 connection in the sequence.
  const releases = await Promise.all([
    acquire(buildAccountSemaphoreKey({ provider: "vllm", accountKey: CONN_5090 }), {
      maxConcurrency: 1,
    }),
    acquire(buildAccountSemaphoreKey({ provider: "ollama-local", accountKey: CONN_4070TI }), {
      maxConcurrency: 1,
    }),
    acquire(buildAccountSemaphoreKey({ provider: "llama-cpp", accountKey: CONN_GLM }), {
      maxConcurrency: 1,
    }),
  ]);

  try {
    // The sequence names only the four tier-1 steps; the un-sequenced tier-2 step
    // is appended as the tail and is reached only after the whole sequence is skipped.
    const combo = {
      name: "t1-exhausted",
      strategy: "priority",
      models: [
        { kind: "model", id: "t1-exhausted-5090a", model: MODEL_5090, connectionId: CONN_5090 },
        {
          kind: "model",
          id: "t1-exhausted-4070ti",
          model: MODEL_4070TI,
          connectionId: CONN_4070TI,
        },
        { kind: "model", id: "t1-exhausted-5090b", model: MODEL_5090, connectionId: CONN_5090 },
        { kind: "model", id: "t1-exhausted-glm", model: MODEL_GLM, connectionId: CONN_GLM },
        { kind: "model", id: "t1-exhausted-t2", model: MODEL_TIER2, connectionId: CONN_TIER2 },
      ],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        dispatchSequence: [
          "t1-exhausted-5090a",
          "t1-exhausted-4070ti",
          "t1-exhausted-5090b",
          "t1-exhausted-glm",
        ],
      },
    };

    const calls: Array<{ modelStr: string; connectionId: string | null }> = [];
    const result = await handleComboChat({
      body: {},
      combo,
      handleSingleModel: async (_body, modelStr, target?: { connectionId?: string | null }) => {
        calls.push({ modelStr, connectionId: target?.connectionId ?? null });
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: [combo],
    });

    assert.equal(result.ok, true, "request must fall through, not stall or error");
    assert.equal(calls.length, 1, "only the reachable tier-2 target is dispatched");
    assert.equal(
      calls[0].connectionId,
      CONN_TIER2,
      "falls through to the tier-2 fallback once the sequence is exhausted"
    );
  } finally {
    for (const release of releases) release();
  }
});
