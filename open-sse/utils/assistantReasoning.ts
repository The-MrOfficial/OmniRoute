import { estimateTokens } from "../services/contextManager.ts";
import { jsonLength } from "./jsonSize.ts";

/** Historical assistant reasoning fields clients echo back on prior turns. */
export const ASSISTANT_REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_details",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Split historical assistant reasoning out of a messages array without mutating
 * it. Returns the reasoning-free messages (unchanged entries keep their identity),
 * the reasoning's raw char count, and its chars/4 token estimate. Non-array input
 * is returned as-is with zero reasoning.
 */
export function splitAssistantReasoning(messages: unknown): {
  messages: unknown;
  reasoningChars: number;
  reasoningCharsPer4Tokens: number;
} {
  if (!Array.isArray(messages)) {
    return { messages, reasoningChars: 0, reasoningCharsPer4Tokens: 0 };
  }
  let reasoningChars = 0;
  let reasoningCharsPer4Tokens = 0;
  const stripped = messages.map((message) => {
    const record = asRecord(message);
    if (!record || record.role !== "assistant") return message;
    let clone: Record<string, unknown> | null = null;
    for (const field of ASSISTANT_REASONING_FIELDS) {
      const value = record[field];
      if (value === undefined || value === null) continue;
      clone ??= { ...record };
      delete clone[field];
      reasoningChars += typeof value === "string" ? value.length : jsonLength(value);
      reasoningCharsPer4Tokens += estimateTokens(value);
    }
    return clone ?? message;
  });
  return { messages: stripped, reasoningChars, reasoningCharsPer4Tokens };
}
