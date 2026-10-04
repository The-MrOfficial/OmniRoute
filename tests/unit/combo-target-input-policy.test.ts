// Combo per-target input policy: config.weightedTargetPolicies[<provider/model>].maxInputTokens.
//
// Live shape (pool/tier1/code, 2026-10-03): the policy says 524288 for
// vllm/qwen3.8-27b-nvfp4, but it had zero readers, so the generic max_input_tokens
// capability override (98304 = 131072 − 32768) always won. The gate now honors the
// policy for combo requests, bounded by the target's real window minus the output
// reserve; direct requests keep the override.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-target-input-policy-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
const capabilityOverrides = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const { resolveComboTargetInputPolicy } =
  await import("../../open-sse/services/combo/targetInputPolicy.ts");
const { resolveInputTokenCapForGate, resolveInputTokenCapForGateWithSource } =
  await import("../../src/lib/modelCapabilities.ts");

const PROVIDER = "vllm";
const MODEL = "qwen3.8-27b-nvfp4";

const pool = {
  name: "pool/tier1/code",
  models: [
    { id: "code-t1-0", kind: "model", model: `${PROVIDER}/${MODEL}`, providerId: PROVIDER },
    { id: "code-t1-2", kind: "model", model: "ollama-local/qwen3.8:27b-iq3-code144k" },
  ],
  config: {
    weightedTargetPolicies: {
      [`${PROVIDER}/${MODEL}`]: { capacityUnits: 1, maxInputTokens: 524_288 },
      "ollama-local/qwen3.8:27b-iq3-code144k": { capacityUnits: 1, maxInputTokens: 524_288 },
    },
  },
};
const hybrid = {
  name: "hybrid/code",
  models: [
    { id: "hybrid-code-tier1", kind: "combo-ref", comboName: "pool/tier1/code" },
    { id: "hybrid-code-tier2", kind: "combo-ref", comboName: "pool/tier2/code" },
  ],
  config: {},
};
const tier2 = {
  name: "pool/tier2/code",
  models: [{ kind: "model", model: "bedrock/qwen.qwen3-coder-next" }],
  config: {},
};
const allCombos = [hybrid, pool, tier2];

test.before(() => {
  core.resetDbInstance();
  assert.equal(contextOverrides.setModelContextOverride(PROVIDER, MODEL, 131_072), true);
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(
      `${PROVIDER}/${MODEL}`,
      "max_input_tokens",
      98_304
    ),
    true
  );
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("reads the policy from the combo that directly contains the target", () => {
  assert.equal(
    resolveComboTargetInputPolicy({
      comboConfig: pool,
      allCombos,
      provider: PROVIDER,
      model: MODEL,
    }),
    524_288
  );
});

test("resolves through a nested combo-ref (hybrid/code → pool/tier1/code)", () => {
  assert.equal(
    resolveComboTargetInputPolicy({
      comboConfig: hybrid,
      allCombos,
      provider: PROVIDER,
      model: MODEL,
    }),
    524_288
  );
});

test("accepts a top-level weightedTargetPolicies shape", () => {
  const legacyShape = {
    name: "legacy",
    models: [`${PROVIDER}/${MODEL}`],
    weightedTargetPolicies: { [`${PROVIDER}/${MODEL}`]: { maxInputTokens: 200_000 } },
  };
  assert.equal(
    resolveComboTargetInputPolicy({
      comboConfig: legacyShape,
      allCombos: [legacyShape],
      provider: PROVIDER,
      model: MODEL,
    }),
    200_000
  );
});

test("returns null for targets without a policy or not in the combo", () => {
  assert.equal(
    resolveComboTargetInputPolicy({
      comboConfig: hybrid,
      allCombos,
      provider: "bedrock",
      model: "qwen.qwen3-coder-next",
    }),
    null
  );
  assert.equal(
    resolveComboTargetInputPolicy({
      comboConfig: hybrid,
      allCombos,
      provider: "openai",
      model: "gpt-4",
    }),
    null
  );
});

test("combo-ref cycles terminate", () => {
  const a = { name: "a", models: [{ kind: "combo-ref", comboName: "b" }], config: {} };
  const b = { name: "b", models: [{ kind: "combo-ref", comboName: "a" }], config: {} };
  assert.equal(
    resolveComboTargetInputPolicy({
      comboConfig: a,
      allCombos: [a, b],
      provider: PROVIDER,
      model: MODEL,
    }),
    null
  );
});

test("combo policy outranks the 98304 override, bounded by window − reserve", () => {
  const resolved = resolveInputTokenCapForGateWithSource(
    { provider: PROVIDER, model: MODEL },
    { isCombo: true, comboTargetInputPolicy: 524_288, outputReserveTokens: 16_384 }
  );
  assert.deepEqual(resolved, { cap: 131_072 - 16_384, source: "combo-policy" });
  // Without a reserve the policy is still bounded by the real 131072 window.
  assert.equal(
    resolveInputTokenCapForGate(
      { provider: PROVIDER, model: MODEL },
      { isCombo: true, comboTargetInputPolicy: 524_288 }
    ),
    131_072
  );
  // A policy smaller than the window is honored as-is.
  assert.equal(
    resolveInputTokenCapForGate(
      { provider: PROVIDER, model: MODEL },
      { isCombo: true, comboTargetInputPolicy: 64_000, outputReserveTokens: 16_384 }
    ),
    64_000
  );
});

test("direct requests ignore the policy and keep the 98304 override", () => {
  assert.deepEqual(
    resolveInputTokenCapForGateWithSource(
      { provider: PROVIDER, model: MODEL },
      { isCombo: false, comboTargetInputPolicy: 524_288, outputReserveTokens: 16_384 }
    ),
    { cap: 98_304, source: "override" }
  );
});

test("combo request without a policy is unchanged (override 98304)", () => {
  assert.equal(
    resolveInputTokenCapForGate({ provider: PROVIDER, model: MODEL }, { isCombo: true }),
    98_304
  );
});
