/**
 * Pure helpers for the home-page Provider Topology panel.
 */

/** Minimal shape expected by <ProviderTopology activeRequests={...}> */
export interface TopologyActiveRequest {
  provider: string;
  model: string;
}

/** Minimal in-flight request shape (subset of LiveRequest from useLiveRequests) */
interface InFlightRequest {
  provider: string;
  model: string;
}

/**
 * Maps an array of in-flight LiveRequest entries to the flat
 * { provider, model }[] shape consumed by <ProviderTopology>.
 *
 * The input is expected to contain only pending/running entries — the
 * useLiveRequests hook already filters out completed and failed requests
 * before exposing them via `activeRequests`.
 */
export function selectActiveRequests(requests: InFlightRequest[]): TopologyActiveRequest[] {
  return requests.map(({ provider, model }) => ({ provider, model }));
}

/** Provider-node row as returned by /api/provider-nodes (only the fields topology needs). */
export type TopologyNodeRow = {
  id?: string;
  prefix?: string;
  name?: string;
  apiType?: string | null;
};

/** Topology entry shape consumed by <ProviderTopology providers={...}>. */
export type TopologyEntry = {
  id: string;
  provider: string;
  name?: string;
  status?: "active" | "error" | "idle";
  /** Extra ids (lowercased) that also identify this node in live/last/error sets. */
  aliases?: string[];
  /** Id used for click-through to /dashboard/providers/<routeId>. */
  routeId?: string;
};

/**
 * Provider-node API types whose handlers emit live request-lifecycle events keyed by the
 * node prefix (embeddings + audio). chat/responses nodes stay connection-driven, and
 * image nodes are excluded because their handlers emit no events (the node could never
 * light up).
 */
const TOPOLOGY_NODE_API_TYPES = new Set(["embeddings", "audio-speech", "audio-transcriptions"]);

/**
 * Returns a new array with one idle entry per connectionless provider-node (Arc embeddings,
 * whisper, kokoro, ...), keyed by lowercased prefix — the provider id those handlers emit and
 * log. The node row id is kept as an alias (audio requests addressed by node id emit it) and
 * as the click-through route id. Nodes already represented (by prefix or node id) are skipped.
 */
export function withProviderNodeEntries<T extends TopologyEntry>(
  entries: T[],
  nodes: TopologyNodeRow[] | null | undefined
): Array<T | TopologyEntry> {
  const result: Array<T | TopologyEntry> = [...entries];
  const taken = new Set<string>();
  for (const entry of entries) {
    taken.add(entry.provider.toLowerCase());
    for (const alias of entry.aliases ?? []) taken.add(alias.toLowerCase());
  }
  for (const node of nodes ?? []) {
    if (!node || !TOPOLOGY_NODE_API_TYPES.has(String(node.apiType ?? ""))) continue;
    const key = (node.prefix ?? "").trim().toLowerCase();
    if (!key) continue;
    const nodeId = (node.id ?? "").trim();
    const nodeIdKey = nodeId.toLowerCase();
    if (taken.has(key)) continue;
    if (nodeIdKey && taken.has(nodeIdKey)) {
      // A connection-backed entry already covers this node under its id; add the
      // prefix as an alias (on a copy) so live events keyed by prefix light it up.
      const index = result.findIndex(
        (existing) =>
          existing.provider.toLowerCase() === nodeIdKey ||
          (existing.aliases ?? []).some((alias) => alias.toLowerCase() === nodeIdKey)
      );
      if (index >= 0) {
        const existing = result[index];
        const aliases = existing.aliases ?? [];
        if (!aliases.some((alias) => alias.toLowerCase() === key)) {
          result[index] = { ...existing, aliases: [...aliases, key] };
        }
      }
      taken.add(key);
      continue;
    }
    const entry: TopologyEntry = {
      id: key,
      provider: key,
      name: node.name?.trim() || node.prefix?.trim() || key,
      status: "idle",
    };
    if (nodeIdKey && nodeIdKey !== key) entry.aliases = [nodeIdKey];
    if (nodeId) entry.routeId = nodeId;
    result.push(entry);
    taken.add(key);
    if (nodeIdKey) taken.add(nodeIdKey);
  }
  return result;
}

/** True when the entry's provider key or any alias is in `set` (case-insensitive). */
export function isTopologyEntryInSet(
  entry: { provider: string; aliases?: string[] },
  set: Set<string>
): boolean {
  if (set.has(entry.provider.toLowerCase())) return true;
  return (entry.aliases ?? []).some((alias) => set.has(alias.toLowerCase()));
}
