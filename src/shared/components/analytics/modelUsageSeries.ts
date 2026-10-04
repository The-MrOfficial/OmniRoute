/**
 * Pure grouping logic for the "Model Usage Over Time" chart.
 *
 * The analytics API returns one 0-filled column per model seen in the range. This module
 * drops non-inference rows, keeps the top-N models by total tokens across the whole range,
 * folds the rest into a single "Other" series, and assigns colors that stay stable per model.
 * No React and no recharts here, so it can be unit-tested with node:test.
 */
import { MODEL_COLORS } from "@/shared/constants/colors";

export const MODEL_USAGE_TOP_N_OPTIONS = [5, 8, 12, "all"] as const;
export type ModelUsageTopN = (typeof MODEL_USAGE_TOP_N_OPTIONS)[number];
export const DEFAULT_MODEL_USAGE_TOP_N: ModelUsageTopN = 8;
export const MODEL_USAGE_TOP_N_STORAGE_KEY = "pref:analytics:modelUsageTopN";
/** Sentinel dataKey so a model literally named "Other" cannot collide with the Other series. */
export const OTHER_SERIES_KEY = "__other__";
export const OTHER_SERIES_COLOR = "#94A3B8";

export type ModelUsageRow = { date: string; dateLabel: string; [key: string]: number | string };
export type ModelUsageSeries = {
  key: string;
  name: string;
  total: number;
  color: string;
  isOther: boolean;
};
export type ModelUsageSeriesResult = {
  rows: ModelUsageRow[];
  series: ModelUsageSeries[];
  hiddenModelCount: number;
};

type DailyByModelRow = { date?: unknown; [key: string]: unknown };

const RESERVED_ROW_KEYS = new Set(["date", "dateLabel"]);
const EXACT_NON_INFERENCE_IDS = new Set(["connection-test", "model-sync"]);
const HEALTH_PROBE_PATTERN = /(^|[-_.:/])health[-_]?(check|probe)s?($|[-_.:/])/i;
const EMBEDDING_PATTERN = /embed/i;

export function parseModelUsageTopN(raw: string | null | undefined): ModelUsageTopN {
  if (raw === "all") return "all";
  const match = MODEL_USAGE_TOP_N_OPTIONS.find(
    (option) => option !== "all" && String(option) === raw
  );
  return match ?? DEFAULT_MODEL_USAGE_TOP_N;
}

/** Connection tests, model sync, health probes and embeddings are not inference usage. */
export function isNonInferenceModel(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  if (EXACT_NON_INFERENCE_IDS.has(normalized)) return true;
  return HEALTH_PROBE_PATTERN.test(normalized) || EMBEDDING_PATTERN.test(normalized);
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Hash each key to a preferred palette slot, then assign in rank order, linear-probing past
 * slots already taken. A model keeps its color whenever its preferred slot is free, and up to
 * MODEL_COLORS.length keys never share a color.
 */
export function assignStableModelColors(keysInRankOrder: string[]): Record<string, string> {
  const paletteSize = MODEL_COLORS.length;
  const usedSlots = new Set<number>();
  const colors: Record<string, string> = {};
  for (const key of keysInRankOrder) {
    if (key in colors) continue;
    const preferred = fnv1a32(key) % paletteSize;
    let slot = preferred;
    if (usedSlots.size < paletteSize) {
      while (usedSlots.has(slot)) slot = (slot + 1) % paletteSize;
    }
    usedSlots.add(slot);
    colors[key] = MODEL_COLORS[slot];
  }
  return colors;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatDateLabel(date: string): string {
  if (!date) return "";
  const parts = date.split("-");
  return `${parts[1]}/${parts[2]}`;
}

export function buildModelUsageSeries(
  dailyByModel: DailyByModelRow[] | null | undefined,
  modelNames: string[] | null | undefined,
  topN: ModelUsageTopN
): ModelUsageSeriesResult {
  const sourceRows = Array.isArray(dailyByModel) ? dailyByModel : [];
  const candidateKeys = new Set<string>();
  for (const name of Array.isArray(modelNames) ? modelNames : []) {
    if (typeof name === "string") candidateKeys.add(name);
  }
  for (const row of sourceRows) {
    for (const key of Object.keys(row ?? {})) candidateKeys.add(key);
  }

  const totals = new Map<string, number>();
  for (const key of candidateKeys) {
    if (RESERVED_ROW_KEYS.has(key) || isNonInferenceModel(key)) continue;
    let total = 0;
    for (const row of sourceRows) total += toFiniteNumber(row?.[key]);
    if (total > 0) totals.set(key, total);
  }

  const ranked = [...totals.keys()].sort((a, b) => {
    const diff = (totals.get(b) ?? 0) - (totals.get(a) ?? 0);
    if (diff !== 0) return diff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const visibleKeys = topN === "all" ? ranked : ranked.slice(0, topN);
  const hiddenKeys = topN === "all" ? [] : ranked.slice(topN);

  let otherTotal = 0;
  const rows: ModelUsageRow[] = sourceRows.map((row) => {
    const date = typeof row?.date === "string" ? row.date : "";
    const out: ModelUsageRow = { date, dateLabel: formatDateLabel(date) };
    for (const key of visibleKeys) out[key] = toFiniteNumber(row?.[key]);
    let otherValue = 0;
    for (const key of hiddenKeys) otherValue += toFiniteNumber(row?.[key]);
    out[OTHER_SERIES_KEY] = otherValue;
    otherTotal += otherValue;
    return out;
  });

  const includeOther = otherTotal > 0;
  if (!includeOther) {
    for (const row of rows) delete row[OTHER_SERIES_KEY];
  }

  const colors = assignStableModelColors(visibleKeys);
  const series: ModelUsageSeries[] = visibleKeys.map((key) => ({
    key,
    name: key,
    total: totals.get(key) ?? 0,
    color: colors[key],
    isOther: false,
  }));
  if (includeOther) {
    series.push({
      key: OTHER_SERIES_KEY,
      name: "Other",
      total: otherTotal,
      color: OTHER_SERIES_COLOR,
      isOther: true,
    });
  }

  return { rows, series, hiddenModelCount: hiddenKeys.length };
}
