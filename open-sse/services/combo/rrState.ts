/**
 * Round-robin sticky state for combo routing.
 *
 * Holds the two mutable module-level Maps that back round-robin distribution
 * (`rrCounters`) and sticky round-robin target affinity (`rrStickyTargets`),
 * plus the helpers that read/write them. Extracted byte-identically from
 * combo.ts (QG v2 Fase 9 T5 D7a).
 *
 * State cohesion: these two Maps MUST remain single instances. combo.ts imports
 * the same references back and mutates them directly (orderTargetsByResetAwareQuota,
 * orderTargetsByResetWindow, handleRoundRobinCombo) — never duplicate a Map.
 *
 * Pure leaf: this module never imports from the combo barrel.
 */

import type { ResolvedComboUnit } from "./types.ts";

// In-memory atomic counter per combo for round-robin distribution
// Resets on server restart (by design — no stale state)
// Eviction limits to prevent unbounded memory growth
export const MAX_RR_COUNTERS = 500;

export const rrCounters = new Map<string, number>();
export const rrStickyTargets = new Map<string, { executionKey: string; successCount: number }>();

/**
 * Per-combo rotating cursor for `config.dispatchSequence` (priority strategy).
 *
 * Mirrors `rrCounters`: a module-level Map keyed by combo name, resets on
 * restart (by design — no stale state), and is evicted at the same
 * `MAX_RR_COUNTERS` cap. Unlike round-robin, this cursor advances at admission
 * (rotation time) rather than at settle, so two concurrent requests see
 * different start offsets into the dispatch sequence (what produces the
 * interleave 5090 → 4070Ti → 5090 → GLM across four simultaneous jobs).
 */
export const dispatchSeqCounters = new Map<string, number>();
export const weightedStickyTargets = new Map<
  string,
  { executionKey: string; successCount: number }
>();

export function clampStickyRoundRobinTargetLimit(value: unknown): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 1;
  return Math.min(Math.max(Math.floor(numericValue), 1), 1000);
}

export const clampStickyWeightedTargetLimit = clampStickyRoundRobinTargetLimit;

/**
 * Return the start offset into a `dispatchSequence` of the given length for
 * this combo, then advance the cursor by one (atomic read-modify-write under
 * Node's single-threaded event loop, matching how `rrCounters` is handled).
 *
 * Advancing at read time is deliberate: request A rotates with counter=0 (head
 * = sequence[0]) and leaves counter=1; request B arriving while A is in flight
 * rotates with counter=1 (head = sequence[1]); and so on. The caller uses the
 * returned offset to rotate the resolved targets. Shares the `MAX_RR_COUNTERS`
 * eviction cap with `rrCounters` to bound memory growth.
 */
export function nextDispatchSequenceStart(comboName: string, length: number): number {
  if (length <= 0) return 0;
  const counter = dispatchSeqCounters.get(comboName) || 0;
  if (!dispatchSeqCounters.has(comboName) && dispatchSeqCounters.size >= MAX_RR_COUNTERS) {
    const oldest = dispatchSeqCounters.keys().next().value;
    if (oldest !== undefined) dispatchSeqCounters.delete(oldest);
  }
  dispatchSeqCounters.set(comboName, counter + 1);
  return counter % length;
}

export function getStickyRoundRobinStartIndex(
  comboName: string,
  targets: ResolvedComboUnit[],
  stickyLimit: number
): { startIndex: number; counter: number } {
  const sticky = rrStickyTargets.get(comboName);
  const stickyIndex = sticky
    ? targets.findIndex((target) => target.executionKey === sticky.executionKey)
    : -1;
  if (stickyLimit > 1 && sticky && stickyIndex >= 0 && sticky.successCount < stickyLimit) {
    return { startIndex: stickyIndex, counter: rrCounters.get(comboName) || 0 };
  }

  const counter = rrCounters.get(comboName) || 0;
  return { startIndex: counter % targets.length, counter };
}

export function recordStickyRoundRobinSuccess(
  comboName: string,
  target: ResolvedComboUnit,
  stickyLimit: number,
  targets: ResolvedComboUnit[]
): void {
  const sticky = rrStickyTargets.get(comboName);
  const successCount = sticky?.executionKey === target.executionKey ? sticky.successCount + 1 : 1;
  if (successCount >= stickyLimit) {
    const servedIndex = targets.findIndex((entry) => entry.executionKey === target.executionKey);
    rrCounters.set(
      comboName,
      servedIndex >= 0 ? servedIndex + 1 : (rrCounters.get(comboName) || 0) + 1
    );
    rrStickyTargets.delete(comboName);
    return;
  }

  rrStickyTargets.set(comboName, { executionKey: target.executionKey, successCount });
}

export function getStickyWeightedExecutionKey(
  comboName: string,
  stickyLimit: number
): string | null {
  const sticky = weightedStickyTargets.get(comboName);
  if (!sticky || stickyLimit <= 1 || sticky.successCount >= stickyLimit) return null;
  return sticky.executionKey;
}

export function recordStickyWeightedSuccess(
  comboName: string,
  executionKey: string,
  stickyLimit: number
): void {
  const sticky = weightedStickyTargets.get(comboName);
  const successCount = sticky?.executionKey === executionKey ? sticky.successCount + 1 : 1;
  if (successCount >= stickyLimit) {
    weightedStickyTargets.delete(comboName);
    return;
  }

  weightedStickyTargets.set(comboName, { executionKey, successCount });
}

/**
 * Sticky batch size for round-robin combo targets (9router parity).
 * Per-combo config → comboStickyRoundRobinLimit → stickyRoundRobinLimit.
 * Uses clampStickyRoundRobinTargetLimit defined above in this module.
 */
export function resolveComboStickyRoundRobinLimit(
  perComboLimit: unknown,
  settings: Record<string, unknown> | null | undefined
): number {
  if (perComboLimit !== undefined && perComboLimit !== null) {
    return clampStickyRoundRobinTargetLimit(perComboLimit);
  }
  const comboSticky = settings?.comboStickyRoundRobinLimit;
  if (comboSticky !== undefined && comboSticky !== null) {
    return clampStickyRoundRobinTargetLimit(comboSticky);
  }
  return clampStickyRoundRobinTargetLimit(settings?.stickyRoundRobinLimit);
}
