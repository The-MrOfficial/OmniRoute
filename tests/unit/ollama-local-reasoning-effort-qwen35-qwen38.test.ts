import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeReasoningEffortForProvider } from "../../open-sse/executors/base/reasoningEffort.ts";
import {
  getRegistryModelThinkingEfforts,
  getRegistryThinkingEfforts,
} from "../../open-sse/config/providerRegistry.ts";

// Backend-aware reasoning_effort normalization for ollama-local.
//
// gremlin-4070ti-ollama (ollama-local) runs qwen3.5/qwen3.8-family Jinja chat
// templates that are SELF-INCONSISTENT about their top reasoning tier. Live
// probe (qwen3.8:27b-iq3-90k, http://10.1.1.12:2701/v1, 2026-10-03):
//   low/medium        → HTTP 200
//   high              → HTTP 500 "Unexpected reasoning effort high"
//   xhigh             → HTTP 500 "Unexpected reasoning effort max"  (template
//                       rewrites explicit xhigh → max, then rejects max)
//   (field omitted)   → HTTP 200 (template applies its own xhigh default)
// So the only explicit values that work are low/medium, and the top tier is
// reachable ONLY by omitting the field. The fix therefore declares the family
// ceiling as medium with `omitEffortAboveDeclaredCeiling`, so the forwarding
// clamp DROPS any above-ceiling request (high/xhigh/max) rather than clamping
// it to a literal value — the backend then defaults to its own xhigh (the
// caller's intent: top reasoning tier). An earlier iteration mapped high→xhigh
// and still 500'd because xhigh is itself rejected; these tests pin the
// corrected drop-the-field behavior.
//
// Every assertion below calls the COMPOSED sanitizer end to end (not the
// registry helpers in isolation) so a future refactor that reintroduces the
// double-defaulting bug (where the opt-out families silently fall through to
// the provider default) fails here immediately.

function hasEffort(body: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(body as Record<string, unknown>, "reasoning_effort");
}

function effortOf(body: unknown): unknown {
  return (body as Record<string, unknown>).reasoning_effort;
}

test("ollama-local qwen3.8 family: high → field dropped (backend defaults to its own xhigh)", () => {
  const out = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "high" },
    "ollama-local",
    "qwen3.8:27b-iq3-code144k"
  );
  assert.equal(hasEffort(out), false, "reasoning_effort must be omitted entirely");
});

test("ollama-local qwen3.8 family: explicit xhigh/max also dropped (template rejects both)", () => {
  for (const tier of ["xhigh", "max"]) {
    const out = sanitizeReasoningEffortForProvider(
      { reasoning_effort: tier },
      "ollama-local",
      "qwen3.8:27b-iq3-90k"
    );
    assert.equal(hasEffort(out), false, `${tier} must be omitted entirely`);
  }
});

test("ollama-local qwen3.5 family: high → field dropped", () => {
  const out = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "high" },
    "ollama-local",
    "qwen3.5:14b"
  );
  assert.equal(hasEffort(out), false, "reasoning_effort must be omitted entirely");
});

test("ollama-local qwen3.8: low/medium pass through unchanged", () => {
  for (const tier of ["low", "medium"]) {
    const out = sanitizeReasoningEffortForProvider(
      { reasoning_effort: tier },
      "ollama-local",
      "qwen3.8:27b-iq3-code144k"
    );
    assert.equal(effortOf(out), tier, `${tier} should pass through unchanged`);
  }
});

test("ollama-local opt-out families keep high (family-prefix probe wins over provider default)", () => {
  // These are DIFFERENT template families on the SAME host. They declare
  // ["none","low","medium","high"] and must NOT be rewritten to xhigh. The
  // registry ids are the bare family segment; the request ids are the full
  // Ollama tags, so this exercises the ":"-split family-prefix match.
  const optOuts: Array<[string, string]> = [
    ["qwen3", "qwen3:14b-q4_K_M"],
    ["qwen3-vl", "qwen3-vl:8b-thinking-q4_K_M"],
    ["gemma4", "gemma4:e4b"],
  ];
  for (const [, modelId] of optOuts) {
    const out = sanitizeReasoningEffortForProvider(
      { reasoning_effort: "high" },
      "ollama-local",
      modelId
    );
    assert.equal(effortOf(out), "high", `${modelId} must keep high (not xhigh)`);
  }
});

test("non-ollama provider with no declared vocabulary is not regressed: high stays high", () => {
  const out = sanitizeReasoningEffortForProvider({ reasoning_effort: "high" }, "openai", "gpt-4o");
  assert.equal(effortOf(out), "high");
});

test("operator override wins and is probed family-aware (bare family id matches full tag)", () => {
  // Override keyed on the bare family "qwen3.8" must be found even though the
  // request carries the fully-tagged "qwen3.8:27b-iq3-code144k". Here the
  // operator declares the template now accepts high literally, so the request
  // must pass through as high (override beats the static xhigh default).
  const overrideLookup = (_provider: string, modelId: string): readonly string[] | null =>
    modelId === "qwen3.8" ? ["low", "medium", "high"] : null;
  const out = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "high" },
    "ollama-local",
    "qwen3.8:27b-iq3-code144k",
    null,
    overrideLookup
  );
  assert.equal(effortOf(out), "high");
});

test("operator override exact-tag form also resolves and wins over the static default", () => {
  const overrideLookup = (_provider: string, modelId: string): readonly string[] | null =>
    modelId === "qwen3.8:27b-iq3-code144k" ? ["low", "medium"] : null;
  // Override vocabulary tops out at medium, so a high request clamps to medium.
  const out = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "high" },
    "ollama-local",
    "qwen3.8:27b-iq3-code144k",
    null,
    overrideLookup
  );
  assert.equal(effortOf(out), "medium");
});

test("ollama-cloud is a confirmed no-op: colon-tagged models unaffected by the family-prefix probe", () => {
  // Regression guard for design Step 2b. gpt-oss:20b exact-matches its own
  // declared vocabulary (never reaching the family-prefix branch); gemma4:31b
  // and qwen3.5:397b have no per-model vocabulary and fall through to the
  // ollama-cloud provider default — identical to today.
  assert.deepEqual(getRegistryModelThinkingEfforts("ollama-cloud", "gpt-oss:20b"), [
    "low",
    "medium",
    "high",
  ]);
  assert.equal(getRegistryModelThinkingEfforts("ollama-cloud", "gemma4:31b"), undefined);
  assert.equal(getRegistryModelThinkingEfforts("ollama-cloud", "qwen3.5:397b"), undefined);
  assert.deepEqual(getRegistryThinkingEfforts("ollama-cloud", "gemma4:31b"), [
    "none",
    "low",
    "medium",
    "high",
    "max",
  ]);

  // high is a native tier for gpt-oss:20b → unchanged.
  const nativeHigh = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "high" },
    "ollama-cloud",
    "gpt-oss:20b"
  );
  assert.equal(effortOf(nativeHigh), "high");
  // high is also within ollama-cloud's provider-default vocabulary → unchanged.
  const defaultHigh = sanitizeReasoningEffortForProvider(
    { reasoning_effort: "high" },
    "ollama-cloud",
    "qwen3.5:397b"
  );
  assert.equal(effortOf(defaultHigh), "high");
});
