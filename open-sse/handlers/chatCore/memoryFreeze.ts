/**
 * Per-conversation memory freeze.
 *
 * Memory retrieval is ranked against the latest user query, so re-running it on
 * every turn reorders or swaps the injected `Memory context: …` text. For
 * strict-system providers that text is merged into the leading system message,
 * which sits right after the tool schemas in the rendered prompt — any change
 * there breaks the upstream prefix/KV cache and forces a re-prefill of the whole
 * conversation (observed on ds4/GLM-5.3: divergence at ~5K tokens every turn).
 *
 * The first request of a conversation retrieves memories as before; that result
 * (including an empty one, so memory never appears mid-conversation) is reused
 * verbatim for every later request with the same owner + conversation key.
 * Entries expire after an idle TTL and the map is LRU-capped.
 */
import type { Memory } from "@/lib/memory/types";

const FREEZE_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
const FREEZE_MAX_ENTRIES = 1000;

interface FrozenEntry {
  memories: Memory[];
  lastUsedAt: number;
}

const frozen = new Map<string, FrozenEntry>();

function freezeKey(ownerId: string, conversationKey: string): string {
  return `${ownerId}\x1f${conversationKey}`;
}

/** Returns the frozen memories for this conversation, or null on a miss/expiry. */
export function getFrozenMemories(
  ownerId: string,
  conversationKey: string,
  now: number = Date.now()
): Memory[] | null {
  const key = freezeKey(ownerId, conversationKey);
  const entry = frozen.get(key);
  if (!entry) return null;
  if (now - entry.lastUsedAt > FREEZE_IDLE_TTL_MS) {
    frozen.delete(key);
    return null;
  }
  // Re-insert to keep Map iteration order = LRU order.
  frozen.delete(key);
  entry.lastUsedAt = now;
  frozen.set(key, entry);
  return entry.memories;
}

export function freezeMemories(
  ownerId: string,
  conversationKey: string,
  memories: Memory[],
  now: number = Date.now()
): void {
  const key = freezeKey(ownerId, conversationKey);
  frozen.delete(key);
  frozen.set(key, { memories: [...memories], lastUsedAt: now });
  while (frozen.size > FREEZE_MAX_ENTRIES) {
    const oldest = frozen.keys().next().value;
    if (oldest === undefined) break;
    frozen.delete(oldest);
  }
}

/** Test hook. */
export function resetFrozenMemories(): void {
  frozen.clear();
}
