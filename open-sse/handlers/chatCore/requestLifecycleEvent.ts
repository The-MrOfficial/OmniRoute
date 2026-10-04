/**
 * Dependency-light home of the terminal request-lifecycle resolver, shared by the chat
 * path (attemptLogging) and non-chat handlers (utils/liveRequestLifecycle).
 */
import type { RequestCompletedPayload, RequestFailedPayload } from "@/lib/events/types";
import { sanitizeErrorMessage } from "../../utils/error.ts";

/**
 * Pure resolver for the terminal request-lifecycle dashboard event. Extracted so the
 * "stuck green" latch fix (emitting request.completed/failed to clear the live topology
 * node) is unit-testable without the DB write in persistAttemptLogs. A 2xx/3xx status
 * with no error is a completion; everything else (including a missing/odd status) is a
 * failure. `id` mirrors the `traceId` used by the paired `request.started`.
 */
export function resolveRequestLifecycleEvent(input: {
  traceId: string;
  status: number;
  error?: string | null;
  model?: string | null;
  provider?: string | null;
  comboName?: unknown;
  tokens?: unknown;
  latencyMs: number;
}):
  | { name: "request.completed"; payload: RequestCompletedPayload }
  | { name: "request.failed"; payload: RequestFailedPayload } {
  const { traceId, status, error, model, provider, comboName, tokens, latencyMs } = input;
  const succeeded = typeof status === "number" && status >= 200 && status < 400 && !error;
  const resolvedComboName = typeof comboName === "string" && comboName ? comboName : undefined;
  if (succeeded) {
    const tokenBag = (tokens && typeof tokens === "object" ? tokens : {}) as Record<
      string,
      unknown
    >;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      name: "request.completed",
      payload: {
        id: traceId,
        status: "success",
        model: model || "unknown",
        provider: provider || "unknown",
        tokensInput: num(tokenBag.input ?? tokenBag.prompt_tokens ?? tokenBag.inputTokens),
        tokensOutput: num(tokenBag.output ?? tokenBag.completion_tokens ?? tokenBag.outputTokens),
        latencyMs,
        comboName: resolvedComboName,
      },
    };
  }
  return {
    name: "request.failed",
    payload: {
      id: traceId,
      // Dashboard listeners and event history cross a public WebSocket boundary. Keep the raw
      // diagnostic in the call log/pipeline above, but expose only the canonical safe projection.
      error: sanitizeErrorMessage(error || `HTTP ${status}`),
      statusCode: typeof status === "number" ? status : undefined,
      latencyMs,
      model: model || undefined,
      provider: provider || undefined,
    },
  };
}
