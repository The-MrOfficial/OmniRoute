/**
 * Live request-lifecycle events for non-chat handlers (embeddings, audio).
 *
 * The dashboard topology lights a provider node on `request.started` and clears it on the
 * matching `request.completed` / `request.failed`. Chat emits these from chatCore +
 * attemptLogging; this helper gives the embeddings and audio handlers the same pair, built
 * on the same pure resolver so payloads match the chat path. Emission is deferred via
 * setImmediate (FIFO, so the terminal event always follows the started one) and never throws
 * into the request path.
 */

import { emit } from "@/lib/events/eventBus";
import { resolveRequestLifecycleEvent } from "../handlers/chatCore/requestLifecycleEvent.ts";

export interface LiveRequestOutcome {
  status: number;
  error?: string | null;
  tokens?: unknown;
}

export interface LiveRequestHandle {
  id: string;
  finish(outcome: LiveRequestOutcome): void;
}

/**
 * Run a route's post-dispatch tail so its live request always reaches a terminal
 * event: a throw finishes it as a 500 (then rethrows). `finish` is idempotent, so a
 * finish the tail already issued wins over this fallback.
 */
export async function runLiveRequestTail<T>(
  live: LiveRequestHandle,
  tail: () => Promise<T>
): Promise<T> {
  try {
    return await tail();
  } catch (error) {
    live.finish({ status: 500, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export function beginLiveRequest(input: {
  provider: string;
  model?: string | null;
  comboName?: string;
}): LiveRequestHandle {
  const id = globalThis.crypto.randomUUID();
  const startTime = Date.now();
  const provider = input.provider || "unknown";
  const model = input.model || "unknown";
  const comboName = input.comboName || undefined;

  setImmediate(() => {
    try {
      emit("request.started", { id, model, provider, timestamp: startTime, comboName });
    } catch {
      // Dashboard events are best-effort; never affect the request.
    }
  });

  let finished = false;
  return {
    id,
    finish(outcome) {
      if (finished) return;
      finished = true;
      const latencyMs = Date.now() - startTime;
      setImmediate(() => {
        try {
          const lifecycle = resolveRequestLifecycleEvent({
            traceId: id,
            status: outcome.status,
            error: outcome.error,
            model,
            provider,
            comboName,
            tokens: outcome.tokens,
            latencyMs,
          });
          if (lifecycle.name === "request.completed") {
            emit("request.completed", lifecycle.payload);
          } else {
            emit("request.failed", lifecycle.payload);
          }
        } catch {
          // Dashboard events are best-effort; never affect the request.
        }
      });
    },
  };
}
