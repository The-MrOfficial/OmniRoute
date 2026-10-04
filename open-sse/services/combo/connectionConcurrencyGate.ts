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
 * FAIL-OPEN vs HARD-CAP, decided by the CALLER on the `saturated` outcome: no
 * connectionId / cap === null / cap <= 0 → `no-limit` (dispatch, unchanged); a
 * successful acquire → `acquired` (dispatch, release when done); a saturated
 * queue / timeout → `saturated`. For cloud/subscription providers the caller
 * keeps the historical FAIL-OPEN (dispatch WITHOUT a slot). For local GPU
 * providers (vllm/ollama-local/llama-cpp, see isHardConcurrencyProvider) the
 * caller treats `saturated` as a HARD cap and SKIPS the target so the request
 * overflows to the next ordered target instead of over-subscribing the GPU.
 */

import * as semaphore from "../rateLimitSemaphore.ts";

/**
 * Default local GPU providers whose per-(connection, model) ceiling is a HARD
 * cap: on saturation the request SKIPS to the next target instead of dispatching
 * anyway. Over-subscribing a single-GPU backend causes OOM/thrash, so these must
 * never exceed their configured concurrency. Overridable via
 * OMNIROUTE_HARD_CONCURRENCY_PROVIDERS (comma-separated).
 */
const DEFAULT_HARD_CONCURRENCY_PROVIDERS = ["vllm", "ollama-local", "llama-cpp"] as const;

/**
 * Resolve the hard-cap provider set from OMNIROUTE_HARD_CONCURRENCY_PROVIDERS
 * (comma-separated, trimmed + lowercased, empties filtered), falling back to the
 * local-GPU default when unset or empty. Read per call — env is cheap and this
 * matches how other env flags are read inline in this codebase.
 */
function resolveHardConcurrencyProviders(): string[] {
  const raw = process.env.OMNIROUTE_HARD_CONCURRENCY_PROVIDERS;
  if (typeof raw === "string") {
    const parsed = raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    if (parsed.length > 0) return parsed;
  }
  return [...DEFAULT_HARD_CONCURRENCY_PROVIDERS];
}

/**
 * True when `provider` is a local GPU backend whose per-(connection, model)
 * ceiling must be enforced as a HARD cap (skip-to-next-target on saturation)
 * rather than the fail-open default used for cloud/subscription providers.
 */
export function isHardConcurrencyProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return resolveHardConcurrencyProviders().includes(provider.trim().toLowerCase());
}

/**
 * Discriminated result of a connection-concurrency slot acquisition.
 *
 * - `acquired`: a slot is held; `release` MUST be called exactly once when the
 *   request finishes (for streaming, only AFTER the stream is fully consumed).
 * - `no-limit`: no cap applies (missing connection/model, `cap === null`, or
 *   `cap <= 0`) — dispatch with no slot.
 * - `saturated`: the queue timed out or was full. The caller decides: hard-cap
 *   providers SKIP the target; non-hard providers FAIL OPEN and dispatch anyway.
 */
export type ConnectionSlotResult =
  { outcome: "acquired"; release: () => void } | { outcome: "no-limit" } | { outcome: "saturated" };

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
 * Returns a discriminated {@link ConnectionSlotResult}: `acquired` with a release
 * callback (for streaming responses, release only AFTER the stream is fully
 * consumed/aborted — see the caller), `no-limit` when no cap applies (missing
 * connection/model, `cap === null`, `cap <= 0`), or `saturated` when the queue
 * timed out or was full. The queue still waits up to `queueTimeoutMs` before
 * reporting `saturated`, so brief bursts wait rather than instantly overflowing.
 *
 * This layer no longer decides dispatch-vs-skip: the CALLER maps `saturated`
 * onto fail-open (dispatch anyway) for cloud/subscription providers or
 * skip-to-next-target for hard-cap local providers (see isHardConcurrencyProvider).
 */
export async function acquireConnectionConcurrencySlot(
  connectionId: string | null | undefined,
  model: string | null | undefined,
  cap: number | null,
  opts: ConnectionSlotOptions,
  log: SlotLogger
): Promise<ConnectionSlotResult> {
  if (!connectionId || !model || cap === null || cap <= 0) return { outcome: "no-limit" };
  try {
    const release = await semaphore.acquire(connectionConcurrencyKey(connectionId, model), {
      maxConcurrency: cap,
      timeoutMs: opts.queueTimeoutMs,
      maxQueueSize: opts.maxQueueSize,
    });
    return { outcome: "acquired", release };
  } catch {
    // A saturated queue / timeout. The caller decides what this means: a cloud
    // provider fails open (dispatch without a slot, preserving availability),
    // while a hard-cap local provider skips this target so it never exceeds its
    // GPU concurrency. Log at debug — the caller logs the resulting decision.
    log.warn(
      "COMBO",
      `Connection concurrency: connection ${connectionId} model ${model} gate saturated (cap=${cap})`
    );
    return { outcome: "saturated" };
  }
}
