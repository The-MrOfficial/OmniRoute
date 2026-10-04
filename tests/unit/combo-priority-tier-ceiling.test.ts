/**
 * @file combo-priority-tier-ceiling.test.ts
 * @description X-OmniRoute-Tier ceiling for non-auto combos: a tier-N request must never
 * escalate into combo steps above tier N (pool/tierN/<lane> combo-refs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tier-ceiling-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const {
  applyTierCeilingToCombo,
  isGlobalFallbackAllowedForTier,
  resolveComboTierCeiling,
  resolveStepTier,
} = await import("../../open-sse/services/combo/tierCeiling.ts");
const { normalizeComboStep } = await import("../../src/lib/combos/steps.ts");
const { comboRefStepInputSchema } = await import("../../src/shared/validation/schemas/combo.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
type ComboLike = import("../../open-sse/services/combo/types.ts").ComboLike;
type ComboRelayOptions = import("../../open-sse/services/combo/types.ts").ComboRelayOptions;

test.after(() => {
  resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function createLog() {
  const debugMessages: string[] = [];
  return {
    debugMessages,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: (...args: unknown[]) => {
        debugMessages.push(args.map(String).join(" "));
      },
    },
  };
}

function okResponse() {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function unavailableResponse() {
  return new Response(JSON.stringify({ error: { message: "busy" } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build pool/tier1..5/<lane> pools (one model each) plus an outer priority combo with
 * combo-ref steps. Each fixture uses its own provider prefix so cooldown/circuit state
 * from one test cannot leak into another.
 */
function buildFixture(
  prefix: string,
  {
    strategy = "priority",
    nestedComboMode = "execute",
    maximumTier = 5,
    extraSteps = [],
    extraCombos = [],
  }: {
    strategy?: string;
    nestedComboMode?: "execute" | "flatten";
    maximumTier?: number;
    extraSteps?: unknown[];
    extraCombos?: ComboLike[];
  } = {}
) {
  const pools: ComboLike[] = [1, 2, 3, 4, 5].map((tier) => ({
    name: `${prefix}/pool/tier${tier}/reader`,
    strategy: "priority",
    models: [{ kind: "model", model: `${prefix}/t${tier}-model` }],
    config: { maxRetries: 0 },
  }));
  const outer: ComboLike = {
    name: `${prefix}/hybrid/reader`,
    strategy,
    models: [
      ...[1, 2, 3, 4, 5].map((tier) => ({
        id: `hybrid-reader-tier${tier}`,
        kind: "combo-ref",
        comboName: `${prefix}/pool/tier${tier}/reader`,
      })),
      ...extraSteps,
    ],
    config: {
      maxRetries: 0,
      ...(nestedComboMode === "execute" ? { nestedComboMode: "execute" } : {}),
      tierRouting: { defaultTier: 1, maximumTier },
    },
  };
  return { outer, allCombos: [outer, ...pools, ...extraCombos] };
}

async function run(
  outer: ComboLike,
  allCombos: ComboLike[],
  failing: Set<string>,
  {
    relayOptions,
    requestHeaders,
  }: {
    relayOptions?: ComboRelayOptions;
    requestHeaders?: Headers;
  } = {}
) {
  const calls: string[] = [];
  const { log, debugMessages } = createLog();
  const response = await handleComboChat({
    body: {},
    combo: outer,
    allCombos,
    log,
    settings: null,
    relayOptions,
    requestHeaders,
    isModelAvailable: async () => true,
    handleSingleModel: async (_body, modelStr) => {
      calls.push(modelStr);
      return failing.has(modelStr) ? unavailableResponse() : okResponse();
    },
  });
  return { response, calls, debugMessages };
}

const tierModels = (prefix: string, tiers: number[]) =>
  tiers.map((tier) => `${prefix}/t${tier}-model`);

test("tier 1 tries only tier1 steps, never tier2+, even when tier1 fails", async () => {
  const prefix = "tc-one";
  const { outer, allCombos } = buildFixture(prefix);
  const { response, calls, debugMessages } = await run(
    outer,
    allCombos,
    new Set(tierModels(prefix, [1])),
    { relayOptions: { tierCeiling: 1 } }
  );
  assert.equal(response.status, 503);
  assert.deepEqual(calls, tierModels(prefix, [1]));
  const excludedLog = debugMessages.find((m) => m.includes("excluded steps"));
  assert.ok(excludedLog, "expected a debug log naming excluded steps");
  for (const tier of [2, 3, 4, 5]) {
    assert.ok(excludedLog.includes(`hybrid-reader-tier${tier}(tier ${tier})`), excludedLog);
  }
});

test("tier 3 admits tiers 1-3 and stops there", async () => {
  const prefixA = "tc-three-a";
  const a = buildFixture(prefixA);
  const first = await run(a.outer, a.allCombos, new Set(tierModels(prefixA, [1, 2])), {
    relayOptions: { tierCeiling: 3 },
  });
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.calls, tierModels(prefixA, [1, 2, 3]));

  const prefixB = "tc-three-b";
  const b = buildFixture(prefixB);
  const second = await run(b.outer, b.allCombos, new Set(tierModels(prefixB, [1, 2, 3])), {
    relayOptions: { tierCeiling: 3 },
  });
  assert.equal(second.response.status, 503);
  assert.deepEqual(second.calls, tierModels(prefixB, [1, 2, 3]));
});

test("no header behaves as today and escalates through every tier", async () => {
  const prefix = "tc-none";
  const { outer, allCombos } = buildFixture(prefix);
  const { response, calls } = await run(
    outer,
    allCombos,
    new Set(tierModels(prefix, [1, 2, 3, 4]))
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, tierModels(prefix, [1, 2, 3, 4, 5]));
});

test("garbage tier values are ignored (same as no header)", async () => {
  const cases: Array<{ relayOptions?: ComboRelayOptions; requestHeaders?: Headers }> = [
    { relayOptions: { tierCeiling: "abc" } },
    { relayOptions: { tierCeiling: 9 } },
    { relayOptions: { tierCeiling: 0 } },
    { requestHeaders: new Headers({ "x-omniroute-tier": "7" }) },
  ];
  for (const [index, options] of cases.entries()) {
    const prefix = `tc-garbage-${index}`;
    const { outer, allCombos } = buildFixture(prefix);
    const { response, calls } = await run(
      outer,
      allCombos,
      new Set(tierModels(prefix, [1, 2, 3, 4])),
      options
    );
    assert.equal(response.status, 200, `case ${index}`);
    assert.deepEqual(calls, tierModels(prefix, [1, 2, 3, 4, 5]), `case ${index}`);
  }
});

test("ceiling read from raw request headers when relayOptions is absent", async () => {
  const prefix = "tc-headers";
  const { outer, allCombos } = buildFixture(prefix);
  const { response, calls } = await run(outer, allCombos, new Set(tierModels(prefix, [1])), {
    requestHeaders: new Headers({ "X-OmniRoute-Tier": "1" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(calls, tierModels(prefix, [1]));
});

test("steps without a derivable tier are admitted", async () => {
  const prefix = "tc-untiered";
  const misc: ComboLike = {
    name: `${prefix}/pool/misc`,
    strategy: "priority",
    models: [{ kind: "model", model: `${prefix}/misc-model` }],
    config: { maxRetries: 0 },
  };
  const { outer, allCombos } = buildFixture(prefix, {
    extraSteps: [
      { kind: "model", model: `${prefix}/plain` },
      { id: "misc-step", kind: "combo-ref", comboName: misc.name },
    ],
    extraCombos: [misc],
  });
  const failing = new Set([...tierModels(prefix, [1]), `${prefix}/plain`]);
  const { response, calls } = await run(outer, allCombos, failing, {
    relayOptions: { tierCeiling: 1 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [...tierModels(prefix, [1]), `${prefix}/plain`, `${prefix}/misc-model`]);
});

test("explicit step tier beats name derivation", () => {
  const combo: ComboLike = {
    name: "explicit",
    strategy: "priority",
    models: [
      { id: "a", kind: "combo-ref", comboName: "pool/tier1/reader", tier: 4 },
      { id: "b", kind: "combo-ref", comboName: "pool/tier5/reader", tier: 1 },
    ],
  };
  const result = applyTierCeilingToCombo(combo, 2, [combo]);
  assert.deepEqual(result.excluded, [{ stepId: "a", tier: 4 }]);
  assert.deepEqual(
    result.combo.models.map((m) => (m as { id: string }).id),
    ["b"]
  );
  assert.equal(combo.models.length, 2, "input combo must not be mutated");
});

test("maximumTier clamps the requested ceiling", async () => {
  const prefix = "tc-clamp";
  const { outer, allCombos } = buildFixture(prefix, { maximumTier: 2 });
  const { response, calls } = await run(
    outer,
    allCombos,
    new Set(tierModels(prefix, [1, 2, 3, 4, 5])),
    { relayOptions: { tierCeiling: 4 } }
  );
  assert.equal(response.status, 503);
  assert.deepEqual(calls, tierModels(prefix, [1, 2]));
});

test("zero admitted steps returns a retryable 503 without calling any target", async () => {
  const prefix = "tc-zero";
  const { allCombos } = buildFixture(prefix);
  const outer: ComboLike = {
    name: `${prefix}/hybrid/cloud-only`,
    strategy: "priority",
    models: [2, 3, 4, 5].map((tier) => ({
      kind: "combo-ref",
      comboName: `${prefix}/pool/tier${tier}/reader`,
    })),
    config: { maxRetries: 0, nestedComboMode: "execute" },
  };
  const { response, calls } = await run(outer, [outer, ...allCombos], new Set(), {
    relayOptions: { tierCeiling: 1 },
  });
  assert.equal(response.status, 503);
  assert.equal(
    response.headers.get("x-omniroute-combo-terminal-reason"),
    "tier_ceiling_no_targets"
  );
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /tier 1/);
  assert.deepEqual(calls, []);
});

test("flatten mode and round-robin never reach tier2+ at ceiling 1", async () => {
  const variants: Array<{ strategy: string; nestedComboMode: "execute" | "flatten" }> = [
    { strategy: "priority", nestedComboMode: "flatten" },
    { strategy: "round-robin", nestedComboMode: "flatten" },
    { strategy: "round-robin", nestedComboMode: "execute" },
    { strategy: "fallback", nestedComboMode: "execute" },
  ];
  for (const variant of variants) {
    const prefix = `tc-${variant.strategy}-${variant.nestedComboMode}`;
    const { outer, allCombos } = buildFixture(prefix, variant);
    const { calls } = await run(outer, allCombos, new Set(tierModels(prefix, [1])), {
      relayOptions: { tierCeiling: 1 },
    });
    const label = `${variant.strategy}/${variant.nestedComboMode}`;
    assert.ok(calls.length > 0, `${label}: tier1 should be attempted`);
    for (const call of calls) {
      assert.equal(call, `${prefix}/t1-model`, `${label}: unexpected call ${call}`);
    }
  }
});

test("auto strategy is not filtered by the step ceiling", async () => {
  const prefix = "tc-auto";
  const { outer } = buildFixture(prefix);
  const autoCombo: ComboLike = { ...outer, strategy: "auto" };
  // The step filter is bypassed for auto (FEAT-005 handles it in the engine), so no
  // "excluded steps" debug line is emitted by the non-auto chokepoint.
  const { log, debugMessages } = createLog();
  await handleComboChat({
    body: {},
    combo: autoCombo,
    allCombos: [autoCombo],
    log,
    settings: null,
    relayOptions: { tierCeiling: 1 },
    isModelAvailable: async () => true,
    handleSingleModel: async () => okResponse(),
  });
  assert.equal(
    debugMessages.some((m) => m.includes("excluded steps")),
    false
  );
});

test("resolveStepTier: explicit, comboName, model string, id suffix, untiered", () => {
  assert.equal(
    resolveStepTier({ id: "x", kind: "combo-ref", comboName: "pool/tier1/r", weight: 0, tier: 3 }),
    3
  );
  assert.equal(
    resolveStepTier({ id: "x", kind: "combo-ref", comboName: "pool/tier2/reader", weight: 0 }),
    2
  );
  assert.equal(resolveStepTier({ id: "x", kind: "combo-ref", comboName: "tier4", weight: 0 }), 4);
  assert.equal(
    resolveStepTier({ id: "x", kind: "model", model: "local/tier3/qwen", weight: 0 }),
    3
  );
  assert.equal(
    resolveStepTier({ id: "reader-tier5", kind: "combo-ref", comboName: "pool/misc", weight: 0 }),
    5
  );
  assert.equal(
    resolveStepTier({ id: "x", kind: "combo-ref", comboName: "pool/tier9/reader", weight: 0 }),
    undefined
  );
  assert.equal(
    resolveStepTier({ id: "x", kind: "combo-ref", comboName: "pool/tiered/reader", weight: 0 }),
    undefined
  );
  assert.equal(
    resolveStepTier({ id: "x", kind: "model", model: "openai/gpt-5", weight: 0 }),
    undefined
  );
});

test("resolveComboTierCeiling: absent, garbage, clamp, plain-record headers", () => {
  assert.equal(resolveComboTierCeiling({}), null);
  assert.equal(resolveComboTierCeiling({ relayOptions: { tierCeiling: "x" } }), null);
  assert.equal(
    resolveComboTierCeiling({ requestHeaders: new Headers({ "x-omniroute-tier": "6" }) }),
    null
  );
  // defaultTier is never applied implicitly.
  assert.equal(
    resolveComboTierCeiling({ config: { tierRouting: { defaultTier: 1, maximumTier: 2 } } }),
    null
  );
  assert.deepEqual(
    resolveComboTierCeiling({
      relayOptions: { tierCeiling: 4 },
      config: { tierRouting: { maximumTier: 2 } },
    }),
    { ceiling: 2, headerTier: 4, maximumTier: 2 }
  );
  assert.deepEqual(
    resolveComboTierCeiling({
      relayOptions: { tierCeiling: 1 },
      config: { tierRouting: { maximumTier: 5 } },
    }),
    { ceiling: 1, headerTier: 1, maximumTier: 5 }
  );
  assert.deepEqual(resolveComboTierCeiling({ requestHeaders: { "X-OmniRoute-Tier": "2" } }), {
    ceiling: 2,
    headerTier: 2,
  });
});

test("isGlobalFallbackAllowedForTier only allows no ceiling or tier 5", () => {
  assert.equal(isGlobalFallbackAllowedForTier(undefined), true);
  assert.equal(isGlobalFallbackAllowedForTier(5), true);
  for (const tier of [1, 2, 3, 4]) {
    assert.equal(isGlobalFallbackAllowedForTier(tier), false, `tier ${tier}`);
  }
});

test("step schema and normalizer carry an explicit tier", () => {
  assert.equal(
    comboRefStepInputSchema.parse({ kind: "combo-ref", comboName: "x", tier: 2 }).tier,
    2
  );
  assert.equal(
    comboRefStepInputSchema.safeParse({ kind: "combo-ref", comboName: "x", tier: 6 }).success,
    false
  );
  assert.equal(normalizeComboStep({ kind: "combo-ref", comboName: "x", tier: 2 })?.tier, 2);
  assert.equal(normalizeComboStep({ kind: "model", model: "a/b", tier: 3 })?.tier, 3);
  assert.equal(normalizeComboStep({ kind: "combo-ref", comboName: "x", tier: 9 })?.tier, undefined);
  assert.equal(
    "tier" in (normalizeComboStep({ kind: "combo-ref", comboName: "x" }) ?? {}),
    false,
    "absent tier must not add a key"
  );
});
