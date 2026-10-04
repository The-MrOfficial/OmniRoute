/**
 * @file tierCeiling.ts
 * @description Per-request `X-OmniRoute-Tier` ceiling for non-auto combos.
 *
 * FEAT-005 applies the ceiling inside the auto-combo engine by model classification.
 * Every other strategy (priority, fallback, round-robin, weighted, ...) walks its
 * steps in order, so a tier-1 (local-only) request used to escalate into
 * `pool/tier2..5/*` steps whenever tier 1 was busy. These helpers filter the
 * combo's steps by their tier before dispatch.
 */
import { normalizeComboStep, type ComboStep } from "../../../src/lib/combos/steps.ts";
import { resolveRequestTier } from "../autoCombo/requestControls.ts";
import type { ComboCollectionLike, ComboLike } from "./types.ts";

const TIER_SEGMENT_RE = /(^|\/)tier(\d)(\/|$)/i;
const TIER_ID_SUFFIX_RE = /-tier(\d)$/i;

function toValidTier(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

/**
 * Resolve a step's cost tier, in order of preference:
 *  (a) an explicit integer `tier` (1-5) on the step;
 *  (b) a `tierN` path segment in the referenced combo name (`pool/tierN/<lane>`) or,
 *      for model steps, in the model string;
 *  (c) a `-tierN` suffix on the step id;
 *  (d) otherwise `undefined` — the step is untiered and always admitted.
 * A derived digit outside 1-5 counts as "no tier".
 */
export function resolveStepTier(step: ComboStep): number | undefined {
  const explicit = toValidTier(step.tier);
  if (explicit !== undefined) return explicit;

  const target =
    step.kind === "combo-ref"
      ? step.comboName
      : step.kind === "model"
        ? step.model
        : `${step.providerId}/${step.modelPattern}`;
  const fromTarget = toValidTier(TIER_SEGMENT_RE.exec(target)?.[2]);
  if (fromTarget !== undefined) return fromTarget;

  return toValidTier(TIER_ID_SUFFIX_RE.exec(step.id)?.[1]);
}

function readTierHeader(
  requestHeaders: Headers | Record<string, unknown> | null | undefined
): unknown {
  if (!requestHeaders) return undefined;
  if (typeof Headers !== "undefined" && requestHeaders instanceof Headers) {
    return requestHeaders.get("x-omniroute-tier");
  }
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (key.toLowerCase() === "x-omniroute-tier") {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

export interface ComboTierCeiling {
  /** Effective ceiling after the `maximumTier` clamp. */
  ceiling: number;
  /** Tier requested by the client (`X-OmniRoute-Tier`). */
  headerTier: number;
  /** `config.tierRouting.maximumTier`, when valid. */
  maximumTier?: number;
}

/**
 * Resolve the effective per-request tier ceiling for a combo.
 *
 * Source: `relayOptions.tierCeiling` (set by the chat handler from `X-OmniRoute-Tier`),
 * falling back to the raw `x-omniroute-tier` request header for callers that pass
 * headers but no relayOptions (safety-net redirect, audio/embeddings).
 *
 * Absent or invalid header => `null` (no ceiling, behavior unchanged). This mirrors
 * FEAT-005's "absent header = unchanged" contract: `config.tierRouting.defaultTier`
 * is intentionally NOT applied implicitly, and `maximumTier` only clamps a ceiling
 * the client actually sent.
 */
export function resolveComboTierCeiling({
  relayOptions,
  requestHeaders,
  config,
}: {
  relayOptions?: { tierCeiling?: unknown } | null;
  requestHeaders?: Headers | Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
}): ComboTierCeiling | null {
  const headerTier =
    resolveRequestTier(relayOptions?.tierCeiling) ??
    resolveRequestTier(readTierHeader(requestHeaders));
  if (headerTier === undefined) return null;

  const tierRouting = config?.tierRouting;
  const maximumTier =
    tierRouting && typeof tierRouting === "object"
      ? toValidTier((tierRouting as { maximumTier?: unknown }).maximumTier)
      : undefined;
  return {
    ceiling: maximumTier !== undefined ? Math.min(headerTier, maximumTier) : headerTier,
    headerTier,
    ...(maximumTier !== undefined ? { maximumTier } : {}),
  };
}

export interface TierCeilingResult {
  combo: ComboLike;
  excluded: Array<{ stepId: string; tier: number }>;
  originalCount: number;
}

/**
 * Drop combo steps whose tier exceeds `ceiling`. Untiered and unnormalizable entries
 * are kept so today's behavior is preserved. Returns the same `combo` object when
 * nothing is excluded; never mutates the input.
 */
export function applyTierCeilingToCombo(
  combo: ComboLike,
  ceiling: number,
  allCombos: ComboCollectionLike
): TierCeilingResult {
  const models = Array.isArray(combo.models) ? combo.models : [];
  const excluded: Array<{ stepId: string; tier: number }> = [];
  const kept = models.filter((entry, index) => {
    const step = normalizeComboStep(entry, { comboName: combo.name, index, allCombos });
    if (!step) return true;
    const tier = resolveStepTier(step);
    if (tier === undefined || tier <= ceiling) return true;
    excluded.push({ stepId: step.id, tier });
    return false;
  });
  if (excluded.length === 0) return { combo, excluded, originalCount: models.length };
  return { combo: { ...combo, models: kept }, excluded, originalCount: models.length };
}

/**
 * The global fallback model (#689) has no tier classification, so it is only allowed
 * when the request carries no ceiling or the ceiling admits everything (tier 5).
 */
export function isGlobalFallbackAllowedForTier(tierCeiling: number | undefined): boolean {
  return tierCeiling === undefined || tierCeiling >= 5;
}
