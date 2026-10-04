import { adaptBodyForCompression } from "../../services/compression/bodyAdapter.ts";
import { estimateTokens } from "../../services/contextManager.ts";
import { splitAssistantReasoning } from "../../utils/assistantReasoning.ts";
import { getContextEstimateMargin, getReasoningCharsPerToken } from "./contextEstimateConfig.ts";

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export type FinalInputTokenBreakdown = {
  messages: number;
  tools: number;
  system: number;
  instructions: number;
  /** Historical assistant reasoning the target will receive (0 when stripped or legacy mode). */
  reasoning: number;
  /** chars/4 of historical assistant reasoning the translator strips (excluded from total). */
  reasoningStripped: number;
  /** Safety multiplier applied to rawTotal (1 when not requested). */
  margin: number;
  /** Sum of the counted buckets before the margin. */
  rawTotal: number;
  total: number;
};

export type FinalInputTokenEstimateOptions = {
  /**
   * Whether historical assistant reasoning (reasoning_content / reasoning /
   * reasoning_details) reaches the target. `true`: counted in its own bucket at
   * the denser reasoning chars/token ratio. `false`: excluded (the translator
   * strips it) and reported as `reasoningStripped`. Omitted: legacy behavior —
   * counted inline in `messages` at chars/4.
   */
  forwardReasoning?: boolean;
  /** Multiply the total by OMNIROUTE_CONTEXT_ESTIMATE_MARGIN (admission estimates only). */
  applyMargin?: boolean;
};

export function estimateFinalInputTokenBreakdown(
  requestBody: JsonRecord | null | undefined,
  options: FinalInputTokenEstimateOptions = {}
): FinalInputTokenBreakdown {
  const adapted = requestBody ? adaptBodyForCompression(requestBody).body : null;
  const nestedRequest = asJsonRecord(requestBody?.request);
  const messages =
    adapted?.messages ||
    requestBody?.contents ||
    nestedRequest?.contents ||
    (Array.isArray(requestBody?.input)
      ? requestBody.input
      : requestBody?.input && typeof requestBody.input === "object"
        ? requestBody.input
        : []);

  let messageTokens: number;
  let reasoning = 0;
  let reasoningStripped = 0;
  if (options.forwardReasoning === undefined) {
    messageTokens = estimateTokens(messages);
  } else {
    const split = splitAssistantReasoning(messages);
    messageTokens = estimateTokens(split.messages);
    if (options.forwardReasoning) {
      reasoning =
        split.reasoningChars > 0
          ? // Epsilon guards float noise (2800 / 2.8 = 1000.0000000000001).
            Math.ceil(split.reasoningChars / getReasoningCharsPerToken() - 1e-9)
          : 0;
    } else {
      reasoningStripped = split.reasoningCharsPer4Tokens;
    }
  }

  const breakdown = {
    messages: messageTokens,
    tools: Array.isArray(requestBody?.tools) ? estimateTokens(requestBody.tools) : 0,
    system: estimateTokens(requestBody?.system),
    instructions: estimateTokens(requestBody?.instructions),
    reasoning,
  };
  const rawTotal =
    breakdown.messages +
    breakdown.tools +
    breakdown.system +
    breakdown.instructions +
    breakdown.reasoning;
  const margin = options.applyMargin ? getContextEstimateMargin() : 1;
  const total = margin === 1 ? rawTotal : Math.ceil(rawTotal * margin);
  return { ...breakdown, reasoningStripped, margin, rawTotal, total };
}

export function estimateFinalInputTokens(
  requestBody: JsonRecord | null | undefined,
  options: FinalInputTokenEstimateOptions = {}
): number {
  return estimateFinalInputTokenBreakdown(requestBody, options).total;
}

/** One-line human-readable rendering of a breakdown for CONTEXT logs. */
export function formatFinalInputTokenBreakdown(breakdown: FinalInputTokenBreakdown): string {
  return (
    `estimate ${breakdown.total} (raw ${breakdown.rawTotal} × margin ${breakdown.margin}) = ` +
    `messages ${breakdown.messages} + tools ${breakdown.tools} + system ${breakdown.system} + ` +
    `instructions ${breakdown.instructions} + reasoning ${breakdown.reasoning} ` +
    `(stripped ${breakdown.reasoningStripped})`
  );
}
