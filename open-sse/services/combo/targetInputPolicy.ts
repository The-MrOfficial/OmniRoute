/**
 * Per-target input policy declared on a combo:
 *
 *   config.weightedTargetPolicies["<provider>/<model>"].maxInputTokens
 *
 * The operator's most specific statement about how much input a concrete combo
 * target accepts. Resolved for the dispatching combo and any nested combo that
 * (transitively) contains the target, nearest-ancestor wins. The final gate in
 * chatCore uses it ahead of the generic `max_input_tokens` capability override
 * for combo requests, bounded by the target's real window minus the output
 * reserve (see resolveInputTokenCapForGate).
 */
import { getComboModelString, normalizeComboStep } from "../../../src/lib/combos/steps.ts";
import { isRecord } from "./comboData.ts";
import { MAX_COMBO_DEPTH } from "./comboPredicates.ts";
import type { ComboInput } from "./types.ts";

type ComboRecordLike = Record<string, unknown>;

function getPolicies(combo: ComboRecordLike): Record<string, unknown> | null {
  const config = isRecord(combo.config) ? combo.config : null;
  const fromConfig =
    config && isRecord(config.weightedTargetPolicies) ? config.weightedTargetPolicies : null;
  if (fromConfig) return fromConfig;
  return isRecord(combo.weightedTargetPolicies) ? combo.weightedTargetPolicies : null;
}

function readMaxInputTokens(
  policies: Record<string, unknown> | null,
  keys: string[]
): number | null {
  if (!policies) return null;
  for (const key of keys) {
    const entry = policies[key];
    if (!isRecord(entry)) continue;
    const value = entry.maxInputTokens;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return null;
}

function getComboName(combo: ComboRecordLike): string {
  return typeof combo.name === "string" ? combo.name.trim() : "";
}

export function resolveComboTargetInputPolicy(params: {
  comboConfig: ComboInput | null | undefined;
  allCombos: ComboInput[] | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
}): number | null {
  const provider = String(params.provider ?? "").trim();
  const model = String(params.model ?? "").trim();
  if (!model || !isRecord(params.comboConfig)) return null;
  const targetKey = provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;

  const allCombos = Array.isArray(params.allCombos) ? params.allCombos.filter(isRecord) : [];
  const byName = new Map<string, ComboRecordLike>();
  for (const combo of allCombos) {
    const name = getComboName(combo);
    if (name) byName.set(name, combo);
  }

  const matchesTarget = (stepModelStr: string | null): boolean => {
    if (!stepModelStr) return false;
    return stepModelStr === targetKey || stepModelStr === model;
  };

  const visited = new Set<string>();
  const visit = (
    combo: ComboRecordLike,
    inherited: number | null,
    depth: number
  ): number | null => {
    const name = getComboName(combo);
    if (name) {
      if (visited.has(name)) return null;
      visited.add(name);
    }
    if (depth > MAX_COMBO_DEPTH) return null;
    const policies = getPolicies(combo);
    const models = Array.isArray(combo.models) ? combo.models : [];

    for (const [index, entry] of models.entries()) {
      const step = normalizeComboStep(entry, { comboName: name, index, allCombos });
      if (!step || step.kind === "combo-ref") continue;
      const stepModelStr = getComboModelString(step);
      if (!matchesTarget(stepModelStr)) continue;
      const own = readMaxInputTokens(policies, [stepModelStr as string, targetKey, model]);
      return own ?? inherited;
    }

    const ownForChildren = readMaxInputTokens(policies, [targetKey, model]) ?? inherited;
    for (const [index, entry] of models.entries()) {
      const step = normalizeComboStep(entry, { comboName: name, index, allCombos });
      if (!step || step.kind !== "combo-ref") continue;
      const child = byName.get(step.comboName);
      if (!child) continue;
      const found = visit(child, ownForChildren, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };

  return visit(params.comboConfig, null, 0);
}
