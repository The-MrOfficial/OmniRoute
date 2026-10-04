/**
 * Embedding input-array splitting.
 *
 * Some self-hosted embedding servers run a whole `input` array as one padded
 * inference. OVMS on the Arc iGPU (`arc-embed` / `ovms-arc`) pads every item to
 * the longest one and allocates GPU buffers from host RAM, so a single
 * 700-item request can need more than 15 GB and OOM-kill the pod. For the
 * providers listed below, OmniRoute splits an oversized array into sequential
 * upstream sub-requests and merges the results back into one OpenAI list.
 *
 * Configuration (environment; provider_nodes have no per-node config bag):
 * - OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS: comma list of provider ids / node
 *   prefixes that get splitting. Each entry is `id` (global limits) or
 *   `id=maxItems:maxPaddedTokens:maxItemTokens` (per-provider override; any
 *   number may be left empty or omitted). `*` matches every provider. Unset defaults to
 *   `arc-embed,ovms-arc`; an empty value, `none`, or `off` disables splitting.
 *   Providers not listed are forwarded unchanged.
 * - OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEMS: global item cap per sub-request (32).
 * - OMNIROUTE_EMBEDDING_SPLIT_MAX_PADDED_TOKENS: global padded-token budget per
 *   sub-request, estimated as item count × longest item (32768).
 * - OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS: global per-item token cap (4096).
 *   One oversized item is a single long OVMS inference that can trip the GPU
 *   watchdog, so no item over the cap is sent upstream. See capEmbeddingItems.
 * - OMNIROUTE_EMBEDDING_ITEM_OVERFLOW: what happens to an item over the cap.
 *   `auto` (default) truncates for internal callers (memory/Qdrant) and rejects
 *   external callers with HTTP 400 so a client never silently gets the vector
 *   of a different text; `truncate` and `reject` force one behavior for all.
 *
 * Token counts are estimated at ESTIMATED_CHARS_PER_TOKEN chars per token
 * (no tokenizer helper exists); token-id array items count one per element.
 */

export interface EmbeddingSplitLimits {
  maxItems: number;
  maxPaddedTokens: number;
  /** Per-item token cap; items over it are truncated or rejected before dispatch. */
  maxItemTokens: number;
}

export type EmbeddingItemOverflowMode = "auto" | "truncate" | "reject";

/** Half-open [start, end) range into the original input array. */
export interface EmbeddingBatchRange {
  start: number;
  end: number;
}

export const DEFAULT_EMBEDDING_SPLIT_PROVIDERS = "arc-embed,ovms-arc";
export const DEFAULT_EMBEDDING_SPLIT_MAX_ITEMS = 32;
export const DEFAULT_EMBEDDING_SPLIT_MAX_PADDED_TOKENS = 32_768;
export const DEFAULT_EMBEDDING_SPLIT_MAX_ITEM_TOKENS = 4096;
/** Conservative chars-per-token ratio; code and JSON tokenize denser than prose. */
export const ESTIMATED_CHARS_PER_TOKEN = 3;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Resolve the split limits for one provider, or null when splitting is off for it. */
export function resolveEmbeddingSplitLimits(
  providerId: string,
  env: Record<string, string | undefined> = process.env
): EmbeddingSplitLimits | null {
  const globalLimits: EmbeddingSplitLimits = {
    maxItems: parsePositiveInt(
      env.OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEMS,
      DEFAULT_EMBEDDING_SPLIT_MAX_ITEMS
    ),
    maxPaddedTokens: parsePositiveInt(
      env.OMNIROUTE_EMBEDDING_SPLIT_MAX_PADDED_TOKENS,
      DEFAULT_EMBEDDING_SPLIT_MAX_PADDED_TOKENS
    ),
    maxItemTokens: parsePositiveInt(
      env.OMNIROUTE_EMBEDDING_SPLIT_MAX_ITEM_TOKENS,
      DEFAULT_EMBEDDING_SPLIT_MAX_ITEM_TOKENS
    ),
  };
  const rawList = env.OMNIROUTE_EMBEDDING_SPLIT_PROVIDERS ?? DEFAULT_EMBEDDING_SPLIT_PROVIDERS;
  const normalizedList = rawList.trim().toLowerCase();
  if (normalizedList === "" || normalizedList === "none" || normalizedList === "off") return null;

  let wildcard: EmbeddingSplitLimits | null = null;
  for (const entry of rawList.split(",")) {
    const [rawId, rawLimits] = entry.split("=", 2);
    const id = rawId.trim();
    if (!id) continue;
    const [rawItems, rawTokens, rawItemTokens] = (rawLimits ?? "").split(":", 3);
    const limits: EmbeddingSplitLimits = {
      maxItems: parsePositiveInt(rawItems, globalLimits.maxItems),
      maxPaddedTokens: parsePositiveInt(rawTokens, globalLimits.maxPaddedTokens),
      maxItemTokens: parsePositiveInt(rawItemTokens, globalLimits.maxItemTokens),
    };
    if (id === providerId) return limits;
    if (id === "*") wildcard = limits;
  }
  return wildcard;
}

/** Resolve OMNIROUTE_EMBEDDING_ITEM_OVERFLOW; unset or invalid values mean `auto`. */
export function resolveEmbeddingItemOverflowMode(
  env: Record<string, string | undefined> = process.env
): EmbeddingItemOverflowMode {
  const raw = (env.OMNIROUTE_EMBEDDING_ITEM_OVERFLOW ?? "").trim().toLowerCase();
  return raw === "truncate" || raw === "reject" ? raw : "auto";
}

/** Estimated token cost of one input item, or null when the item is not plain text/tokens. */
export function estimateItemTokens(item: unknown): number | null {
  if (typeof item === "string")
    return Math.max(1, Math.ceil(item.length / ESTIMATED_CHARS_PER_TOKEN));
  if (Array.isArray(item) && item.every((token) => typeof token === "number")) {
    return Math.max(1, item.length);
  }
  return null;
}

export interface EmbeddingItemOverflow {
  index: number;
  estimatedTokens: number;
}

function isTokenArray(item: unknown): item is number[] {
  return Array.isArray(item) && item.length > 0 && item.every((token) => typeof token === "number");
}

/**
 * Cap every plain text/token item at `maxItemTokens`. Strings are cut to
 * `maxItemTokens × ESTIMATED_CHARS_PER_TOKEN` chars, token arrays to
 * `maxItemTokens` ids; structured items pass through. Accepts a single item or
 * an array (a flat array of token ids is one item). `overflows` lists every
 * item that was over the cap with its pre-truncation estimate; the input is
 * returned unchanged (same reference) when nothing overflows.
 */
export function capEmbeddingItems(
  input: unknown,
  maxItemTokens: number
): { input: unknown; overflows: EmbeddingItemOverflow[] } {
  const overflows: EmbeddingItemOverflow[] = [];
  const maxChars = maxItemTokens * ESTIMATED_CHARS_PER_TOKEN;
  const capItem = (item: unknown, index: number): unknown => {
    const estimate = estimateItemTokens(item);
    if (estimate === null || estimate <= maxItemTokens) return item;
    overflows.push({ index, estimatedTokens: estimate });
    return typeof item === "string"
      ? item.slice(0, maxChars)
      : (item as number[]).slice(0, maxItemTokens);
  };
  const capped =
    !Array.isArray(input) || isTokenArray(input) ? capItem(input, 0) : input.map(capItem);
  return { input: overflows.length > 0 ? capped : input, overflows };
}

/**
 * Plan contiguous sub-batches for a text/token input array. Returns null when
 * the input is not a plain array, contains structured items, or already fits
 * in one request, so the caller forwards it unchanged.
 */
export function planEmbeddingBatches(
  input: unknown,
  limits: EmbeddingSplitLimits
): EmbeddingBatchRange[] | null {
  if (!Array.isArray(input) || input.length < 2) return null;
  const tokens: number[] = [];
  for (const item of input) {
    const estimate = estimateItemTokens(item);
    if (estimate === null) return null;
    tokens.push(estimate);
  }

  const batches: EmbeddingBatchRange[] = [];
  let start = 0;
  let longest = 0;
  for (let index = 0; index < tokens.length; index++) {
    const count = index - start;
    const nextLongest = Math.max(longest, tokens[index]);
    const overItems = count + 1 > limits.maxItems;
    const overTokens = (count + 1) * nextLongest > limits.maxPaddedTokens;
    if (count > 0 && (overItems || overTokens)) {
      batches.push({ start, end: index });
      start = index;
      longest = tokens[index];
    } else {
      longest = nextLongest;
    }
  }
  batches.push({ start, end: tokens.length });
  return batches.length > 1 ? batches : null;
}

interface EmbeddingUsage {
  prompt_tokens?: number;
  total_tokens?: number;
}

export interface EmbeddingBatchPart {
  /** Position of this part's first item in the original input array. */
  offset: number;
  body: Record<string, unknown>;
}

/**
 * Merge sub-batch responses into one OpenAI list: data[].index is remapped to
 * the original input position, usage is summed, and the first model is kept.
 */
export function mergeEmbeddingBatchResponses(parts: EmbeddingBatchPart[]): Record<string, unknown> {
  const data: Array<Record<string, unknown>> = [];
  let promptTokens = 0;
  let totalTokens = 0;
  let model: unknown;
  for (const part of parts) {
    const items = Array.isArray(part.body.data) ? part.body.data : [];
    items.forEach((item: unknown, position: number) => {
      if (!item || typeof item !== "object") {
        throw new Error("Embedding provider returned an invalid embedding item");
      }
      const record = item as Record<string, unknown>;
      const localIndex = typeof record.index === "number" ? record.index : position;
      data.push({ ...record, index: part.offset + localIndex });
    });
    const usage = (part.body.usage ?? {}) as EmbeddingUsage;
    promptTokens += usage.prompt_tokens || usage.total_tokens || 0;
    totalTokens += usage.total_tokens || usage.prompt_tokens || 0;
    if (model === undefined && part.body.model !== undefined) model = part.body.model;
  }
  data.sort((a, b) => (a.index as number) - (b.index as number));
  return {
    object: "list",
    data,
    ...(model !== undefined ? { model } : {}),
    usage: { prompt_tokens: promptTokens, total_tokens: totalTokens },
  };
}
