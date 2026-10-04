/**
 * connectionConcurrencyGate.ts — Process-global per-(connection, model) concurrency
 * ceiling for the priority / dispatchSequence / fallback execution path (#esnixi-5090).
 *
 * BUG this closes: a provider connection's `maxConcurrent` ceiling was enforced
 * PER COMBO DISPATCH, not globally. When two different combos that both list the
 * same model (e.g. `hybrid/code` + `hybrid/research`, both targeting the 5090 27B
 * connection, cap=2) ran at once, each built its own per-dispatch resolver via
 * makeConnectionConcurrencyResolver (concurrencyCaps.ts) and independently admitted
 * up to 2 → 2+2, and 3 concurrent requests were observed on the connection.
 *
 * A SECOND bug this closes: keying the gate on `conn:<connectionId>` ALONE made
 * every model hosted on one connection share a single ceiling. The 4070 Ti
 * connection hosts both a 27B coder (per-model cap 1) and a 9B reader (cap 4);
 * under a connection-only key the 27B could run 4 concurrent because it inherited
 * the connection's maxConcurrent. The key now includes the model so each
 * (connection, model) pair gets an independent ceiling.
 *
 * THE FIX: a single process-global semaphore keyed `conn:<connectionId>:<model>`,
 * acquired once around the upstream dispatch in executeTargetAttempt, with a
 * per-(connection, model) cap resolved at dispatch time. Two different combos
 * targeting the SAME (connection, model) still share one ceiling (the 5090 27B
 * across hybrid/code + hybrid/research — the Nth-over-cap request WAITS instead
 * of flooding), while two DIFFERENT models on one connection (4070 Ti 27B vs 9B)
 * now get independent ceilings.
 *
 * RECONCILIATION — exactly ONE global ceiling per request path, no double-acquire:
 *   - Round-robin never reaches executeTargetAttempt (combo.ts early-returns into
 *     handleRoundRobinCombo), and its semaphore key is `combo:<name>:<step>`, not
 *     connection-scoped — this gate never fires for it, so no double-acquire.
 *   - Quota-share DOES reach executeTargetAttempt but already holds its own
 *     per-connection slot keyed `qsconn:<connectionId>` (acquireQuotaShareConcurrencySlot)
 *     for the whole cooldown-aware re-dispatch. To avoid a second ceiling on the same
 *     request (and a self-deadlock across retries), the caller SKIPS this gate when
 *     `strategy === "quota-share"`; quota-share keeps its proven single `qsconn:` gate.
 *   - All other strategies (priority, weighted, fill-first, dispatchSequence, fallback)
 *     had NO per-connection gate before; they now share the new `conn:` ceiling.
 *
 * DOCUMENTED CAVEAT: `qsconn:` and `conn:` are distinct keys, so a quota-share
 * request and a priority-path request to the SAME physical connection count against
 * two separate gates. This is acceptable and out of scope: the reported bug is
 * cross-combo among priority-path combos, which all use `conn:` and share one ceiling.
 * Unifying quota-share onto `conn:` is deliberately NOT done here to avoid changing
 * quota-share's proven behavior / other lanes.
 *
 * FAIL-OPEN, exactly like acquireQuotaShareConcurrencySlot: no connectionId /
 * cap === null / cap <= 0 → no limit; a saturated queue / timeout → proceed WITHOUT
 * a slot rather than ever failing a dispatchable request.
 */

import * as semaphore from "../rateLimitSemaphore.ts";

/**
 * Stable, (connection, model)-scoped semaphore key for the global gate. Two
 * combos sharing the same (connection, model) share one ceiling; two different
 * models on one connection get independent ceilings.
 */
export function connectionConcurrencyKey(connectionId: string, model: string): string {
  return `conn:${connectionId}:${model}`;
}

export interface ConnectionSlotOptions {
  /** Max time a request waits in the queue before failing open (ms). */
  queueTimeoutMs: number;
  /** Max queued waiters before the gate fails open instead of queueing more. */
  maxQueueSize: number;
}

interface SlotLogger {
  warn: (tag: string, message: string) => void;
}

/**
 * Acquire the process-global per-connection concurrency slot for a dispatch.
 *
 * Returns a release callback to invoke once the request finishes (for streaming
 * responses: only AFTER the stream is fully consumed/aborted — see the caller),
 * or `null` when no limit applies (missing connection, `cap === null`,
 * `cap <= 0`) or the gate is saturated. Fail-open is deliberate: this layer must
 * never make a dispatchable request fail — a full queue / timeout proceeds
 * WITHOUT a slot.
 */
export async function acquireConnectionConcurrencySlot(
  connectionId: string | null | undefined,
  model: string | null | undefined,
  cap: number | null,
  opts: ConnectionSlotOptions,
  log: SlotLogger
): Promise<(() => void) | null> {
  if (!connectionId || !model || cap === null || cap <= 0) return null;
  try {
    return await semaphore.acquire(connectionConcurrencyKey(connectionId, model), {
      maxConcurrency: cap,
      timeoutMs: opts.queueTimeoutMs,
      maxQueueSize: opts.maxQueueSize,
    });
  } catch {
    // Fail-open: a saturated queue / timeout must never worsen availability —
    // proceed without a slot rather than reject a dispatchable request.
    log.warn(
      "COMBO",
      `Connection concurrency: connection ${connectionId} model ${model} gate saturated (cap=${cap}) — proceeding without a slot`
    );
    return null;
  }
}
