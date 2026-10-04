import test from "node:test";
import assert from "node:assert/strict";

const { createComboSchema } = await import("../../../src/shared/validation/schemas/combo.ts");
const { normalizeComboModels } = await import("../../../src/lib/combos/steps.ts");
const { PROVIDER_BREAKER_FAILURE_STATUSES } =
  await import("../../../src/sse/handlers/chatPredicates.ts");

// The exact payload the operator POSTs to create the hybrid/reader tiered combo
// (design §4.4 C). Connection UUIDs are the committed, fleet-maintained map in
// home/programs/omniroute-routing.py (vllm / ollama-local / ollama-m5-reader).
// fill-first = strict priority-ordered step order with error-driven overflow.
const GREMLIN_CONN = "b20e0770-3e14-40c1-87cd-85c34b34381a"; // 4070 Ti Super (ollama-local)
const ESNIXI_CONN = "e9bd13fb-c6b6-4c18-b42f-3395266348ce"; // 5090 native vLLM
const M5_CONN = "598cf9d0-c780-4534-ae12-db324c99b588"; // M5 Max reader

const hybridReaderPayload = {
  name: "hybrid/reader",
  strategy: "fill-first",
  models: [
    {
      id: "reader-t1-gremlin-4070ti",
      kind: "model" as const,
      model: "ollama/qwen3.5-reader:9b",
      providerId: "ollama",
      connectionId: GREMLIN_CONN,
      weight: 0,
    },
    {
      id: "reader-t2-esnixi-5090",
      kind: "model" as const,
      model: "vllm/qwen3.5-9b-nvfp4-reader",
      providerId: "vllm",
      connectionId: ESNIXI_CONN,
      weight: 0,
    },
    {
      id: "reader-t3-m5max",
      kind: "model" as const,
      model: "ollama/qwen3.5-reader:9b",
      providerId: "ollama",
      connectionId: M5_CONN,
      weight: 0,
    },
  ],
  context_length: 32768,
  context_cache_protection: false,
};

test("hybrid/reader payload passes createComboSchema", () => {
  const result = createComboSchema.safeParse(hybridReaderPayload);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues ?? [], null, 2));
  assert.equal(result.data!.name, "hybrid/reader");
  assert.equal(result.data!.strategy, "fill-first");
  assert.equal(result.data!.context_length, 32768);
});

test("comboNameSchema allows the slash in hybrid/reader", () => {
  // name is accepted by createComboSchema above; assert the slash specifically.
  const ok = createComboSchema.safeParse({ ...hybridReaderPayload, name: "hybrid/reader" });
  assert.equal(ok.success, true);
});

test("normalizeComboModels yields three model steps in tier order with distinct pins", () => {
  const steps = normalizeComboModels(hybridReaderPayload.models, { comboName: "hybrid/reader" });
  assert.equal(steps.length, 3);
  for (const s of steps) assert.equal(s.kind, "model");

  // fill-first preserves the authored step order = tier order.
  const modelSteps = steps as Array<{
    kind: "model";
    model: string;
    connectionId?: string | null;
  }>;
  assert.deepEqual(
    modelSteps.map((s) => s.connectionId),
    [GREMLIN_CONN, ESNIXI_CONN, M5_CONN]
  );

  // Tiers 1 and 3 share the SAME model string but DIFFERENT connectionId pins:
  // the connectionId is the dispatch pin, so they route to different physical GPUs.
  assert.equal(modelSteps[0].model, "ollama/qwen3.5-reader:9b");
  assert.equal(modelSteps[2].model, "ollama/qwen3.5-reader:9b");
  assert.equal(modelSteps[0].model, modelSteps[2].model);
  assert.notEqual(modelSteps[0].connectionId, modelSteps[2].connectionId);

  // Tier 2 is the esnixi 5090 reader.
  assert.equal(modelSteps[1].model, "vllm/qwen3.5-9b-nvfp4-reader");
});

test("a switcher 409 is NOT a provider-breaker trip (so fill-first just falls through)", () => {
  // The esnixi switcher returns 409 'RTX 5090 is busy; use the next OmniRoute
  // fallback' when the coder is active. 409 must not open the vllm provider
  // circuit; it only advances fill-first to the next tier.
  assert.equal(PROVIDER_BREAKER_FAILURE_STATUSES.has(409), false);
  // Sanity: the real breaker statuses are unchanged.
  for (const s of [408, 500, 502, 503, 504]) {
    assert.equal(PROVIDER_BREAKER_FAILURE_STATUSES.has(s), true);
  }
});
