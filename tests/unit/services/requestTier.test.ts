/**
 * Per-request cost-tier ceiling (#FEAT-005).
 *
 * `resolveRequestTier` parses the `X-OmniRoute-Tier` header into an integer 1-5
 * ceiling (anything else => undefined so the stored combo config stands), and the
 * auto-combo engine admits only candidates whose classified tier is within the band
 * that ceiling allows. Tier 3 admits free + cheap and excludes a premium-only pool;
 * an absent ceiling leaves the full candidate pool untouched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { resolveRequestTier, resolveRequestAutoControls } =
  await import("../../../open-sse/services/autoCombo/requestControls.ts");
const { selectProvider } = await import("../../../open-sse/services/autoCombo/engine.ts");
const { setTierPricingSnapshot, clearTierCache, setTierConfig } =
  await import("../../../open-sse/services/tierResolver.ts");
const { DEFAULT_WEIGHTS } = await import("../../../open-sse/services/autoCombo/scoring.ts");

type ProviderCandidate = Parameters<typeof selectProvider>[1][number];

function candidate(provider: string, model: string, costPer1MTokens: number): ProviderCandidate {
  return {
    provider,
    model,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens,
    p95LatencyMs: 1000,
    latencyStdDev: 100,
    errorRate: 0,
  };
}

// Default thresholds (tierConfig.ts): freeThreshold=0, cheapThreshold=1.0.
// input <= 0 => free, <= 1.0 => cheap, > 1.0 => premium.
function seedTierPricing(): void {
  setTierConfig({});
  setTierPricingSnapshot({
    "local-free": { "free-model": { input: 0, output: 0 } },
    "local-cheap": { "cheap-model": { input: 0.5, output: 0.5 } },
    cloud: { "premium-model": { input: 10, output: 30 } },
  });
  clearTierCache();
}

function releaseTierPricing(): void {
  setTierPricingSnapshot(null);
  setTierConfig({});
}

test("resolveRequestTier accepts integers 1-5", () => {
  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal(resolveRequestTier(n), n);
    assert.equal(resolveRequestTier(String(n)), n);
    assert.equal(resolveRequestTier(` ${n} `), n);
  }
});

test("resolveRequestTier rejects out-of-range, non-integer, and non-numeric input", () => {
  for (const bad of [0, 6, -1, 2.5, "x", "", "  ", NaN, null, undefined, {}, [], true]) {
    assert.equal(resolveRequestTier(bad as unknown), undefined);
  }
});

test("resolveRequestAutoControls threads X-OmniRoute-Tier only when valid", () => {
  const withTier = resolveRequestAutoControls(
    new Headers({ "x-omniroute-tier": "3" }) as unknown as { get(name: string): string | null }
  );
  assert.equal(withTier.tierCeiling, 3);

  const absent = resolveRequestAutoControls(
    new Headers() as unknown as { get(name: string): string | null }
  );
  assert.equal("tierCeiling" in absent, false);

  const garbage = resolveRequestAutoControls(
    new Headers({ "x-omniroute-tier": "9" }) as unknown as { get(name: string): string | null }
  );
  assert.equal("tierCeiling" in garbage, false);
});

test("tier=3 admits tier<=3 candidates and excludes a premium-only pick", () => {
  seedTierPricing();
  try {
    const candidates: ProviderCandidate[] = [
      candidate("local-free", "free-model", 0),
      candidate("local-cheap", "cheap-model", 0.5),
      candidate("cloud", "premium-model", 10),
    ];
    const baseConfig = {
      id: "auto-tier-test",
      name: "auto-tier-test",
      type: "auto" as const,
      candidatePool: [],
      weights: DEFAULT_WEIGHTS,
      explorationRate: 0, // deterministic: no random exploratory picks
    };

    // Over many runs the premium (tier > 3) model must never be selected.
    const picked = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const result = selectProvider({ ...baseConfig, tierCeiling: 3 }, candidates, "default");
      picked.add(result.provider);
    }
    assert.equal(picked.has("cloud"), false, "premium candidate must be excluded at tier 3");
    for (const p of picked) {
      assert.ok(["local-free", "local-cheap"].includes(p), `unexpected selection: ${p}`);
    }
  } finally {
    releaseTierPricing();
  }
});

test("tier=1 admits only free candidates", () => {
  seedTierPricing();
  try {
    const candidates: ProviderCandidate[] = [
      candidate("local-free", "free-model", 0),
      candidate("local-cheap", "cheap-model", 0.5),
      candidate("cloud", "premium-model", 10),
    ];
    const config = {
      id: "auto-tier1",
      name: "auto-tier1",
      type: "auto" as const,
      candidatePool: [],
      weights: DEFAULT_WEIGHTS,
      explorationRate: 0,
      tierCeiling: 1,
    };
    for (let i = 0; i < 50; i += 1) {
      const result = selectProvider(config, candidates, "default");
      assert.equal(result.provider, "local-free");
    }
  } finally {
    releaseTierPricing();
  }
});

test("absent ceiling leaves the full candidate pool available (premium reachable)", () => {
  seedTierPricing();
  try {
    // Only a premium candidate: with no ceiling it must still be selectable
    // (stored combo config stands when the header is absent).
    const candidates: ProviderCandidate[] = [candidate("cloud", "premium-model", 10)];
    const config = {
      id: "auto-no-ceiling",
      name: "auto-no-ceiling",
      type: "auto" as const,
      candidatePool: [],
      weights: DEFAULT_WEIGHTS,
      explorationRate: 0,
    };
    const result = selectProvider(config, candidates, "default");
    assert.equal(result.provider, "cloud");
  } finally {
    releaseTierPricing();
  }
});
