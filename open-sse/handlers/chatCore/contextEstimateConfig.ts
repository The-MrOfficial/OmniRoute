/**
 * Tunables for the pre-flight context admission estimate (chatCore final gate).
 * Read per call so operators can change them without a restart in tests; invalid
 * or out-of-range values fall back to the defaults.
 */

/** chars/4 measured −5.2% vs the vLLM tokenizer on a real Zoo agent body; ×1.10 lands ≈+4%. */
export const DEFAULT_CONTEXT_ESTIMATE_MARGIN = 1.1;
/** Forwarded assistant reasoning tokenizes densely (measured 2.54–2.89 chars/token). */
export const DEFAULT_REASONING_CHARS_PER_TOKEN = 2.8;
/** Output room reserved when the client sends no max_tokens-style field. */
export const DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS = 16384;

function readFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** OMNIROUTE_CONTEXT_ESTIMATE_MARGIN: float in [1.0, 2.0], default 1.10. */
export function getContextEstimateMargin(): number {
  return readFloat("OMNIROUTE_CONTEXT_ESTIMATE_MARGIN", DEFAULT_CONTEXT_ESTIMATE_MARGIN, 1, 2);
}

/** OMNIROUTE_CONTEXT_REASONING_CHARS_PER_TOKEN: float in [1.0, 8.0], default 2.8. */
export function getReasoningCharsPerToken(): number {
  return readFloat(
    "OMNIROUTE_CONTEXT_REASONING_CHARS_PER_TOKEN",
    DEFAULT_REASONING_CHARS_PER_TOKEN,
    1,
    8
  );
}

/** OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS: integer ≥ 0, default 16384 (0 = legacy ≥1-token check). */
export function getContextOutputReserveTokens(): number {
  const raw = process.env.OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS;
}
