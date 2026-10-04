import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isTopologyEntryInSet,
  withProviderNodeEntries,
  type TopologyEntry,
  type TopologyNodeRow,
} from "../../src/app/(dashboard)/home/topologyUtils.ts";

// Arc embeddings/audio provider-nodes are local no-auth nodes with no connection row, so the
// connection-driven topology list dropped them. They are merged in keyed by prefix (the id
// their handlers emit and log) with the node row id as an alias / click-through id.

const ARC_EMBED_ID = "openai-compatible-embeddings-1710a12f-6af6-4052-8f0b-a3c17175dabb";
const OVMS_ARC_ID = "openai-compatible-embeddings-8a59c128-2c08-45bb-8aae-554a2440bd00";
const ARC_WHISPER_ID =
  "openai-compatible-audio-transcriptions-0b6c1d2e-aaaa-bbbb-cccc-111122223333";
const ARC_KOKORO_ID = "openai-compatible-audio-speech-4d5e6f70-aaaa-bbbb-cccc-444455556666";

const NODES: TopologyNodeRow[] = [
  { id: ARC_EMBED_ID, prefix: "arc-embed", name: "Arc Embeddings", apiType: "embeddings" },
  { id: OVMS_ARC_ID, prefix: "ovms-arc", name: "Arc OVMS (zoo alias)", apiType: "embeddings" },
  {
    id: ARC_WHISPER_ID,
    prefix: "arc-whisper",
    name: "Arc Whisper",
    apiType: "audio-transcriptions",
  },
  { id: ARC_KOKORO_ID, prefix: "arc-kokoro", name: "Arc Kokoro", apiType: "audio-speech" },
  { id: "openai-compatible-chat-x", prefix: "arc-chat", name: "Arc Chat", apiType: "chat" },
  {
    id: "openai-compatible-images-x",
    prefix: "arc-img",
    name: "Arc Images",
    apiType: "images-generations",
  },
  { id: "openai-compatible-embeddings-noprefix", prefix: "  ", apiType: "embeddings" },
];

const BASE: TopologyEntry[] = [
  { id: "openai", provider: "openai", name: "OpenAI", status: "active" },
];

test("withProviderNodeEntries adds the four Arc nodes keyed by prefix", () => {
  const out = withProviderNodeEntries(BASE, NODES);
  assert.equal(out[0], BASE[0], "existing entries kept first and untouched");
  const byKey = new Map(out.map((e) => [e.provider, e]));
  const expected: Array<[string, string, string]> = [
    ["arc-embed", "Arc Embeddings", ARC_EMBED_ID],
    ["ovms-arc", "Arc OVMS (zoo alias)", OVMS_ARC_ID],
    ["arc-whisper", "Arc Whisper", ARC_WHISPER_ID],
    ["arc-kokoro", "Arc Kokoro", ARC_KOKORO_ID],
  ];
  for (const [key, name, nodeId] of expected) {
    const entry = byKey.get(key);
    assert.ok(entry, `${key} must be a topology node`);
    assert.equal(entry.id, key);
    assert.equal(entry.name, name);
    assert.equal(entry.status, "idle");
    assert.deepEqual(entry.aliases, [nodeId.toLowerCase()]);
    assert.equal(entry.routeId, nodeId);
  }
  assert.equal(out.length, BASE.length + 4);
});

test("withProviderNodeEntries skips chat, image, and prefix-less nodes", () => {
  const keys = withProviderNodeEntries([], NODES).map((e) => e.provider);
  assert.ok(!keys.includes("arc-chat"));
  assert.ok(!keys.includes("arc-img"));
  assert.ok(!keys.includes(""));
  assert.equal(keys.length, 4);
});

test("withProviderNodeEntries does not duplicate a node already present by prefix or id", () => {
  const byPrefix = withProviderNodeEntries(
    [{ id: "arc-embed", provider: "ARC-EMBED", status: "active" }],
    NODES
  );
  assert.equal(byPrefix.filter((e) => e.provider.toLowerCase() === "arc-embed").length, 1);
  const byIdInput = { id: ARC_KOKORO_ID, provider: ARC_KOKORO_ID, status: "active" };
  const byId = withProviderNodeEntries([byIdInput], NODES);
  assert.ok(!byId.some((e) => e.provider === "arc-kokoro"));
  // The connection-backed entry gains the node prefix as an alias, so live events
  // keyed by prefix light it up; the input entry itself is left untouched.
  const kokoro = byId.find((e) => e.provider === ARC_KOKORO_ID);
  assert.ok(kokoro);
  assert.ok(kokoro.aliases?.includes("arc-kokoro"));
  assert.equal(isTopologyEntryInSet(kokoro, new Set(["arc-kokoro"])), true);
  assert.deepEqual(byIdInput, { id: ARC_KOKORO_ID, provider: ARC_KOKORO_ID, status: "active" });
  const dupNodes = withProviderNodeEntries([], [NODES[0], { ...NODES[0], id: "other" }]);
  assert.equal(dupNodes.length, 1);
});

test("withProviderNodeEntries does not mutate its inputs and tolerates null nodes", () => {
  const base = BASE.map((e) => ({ ...e }));
  const nodes = NODES.map((n) => ({ ...n }));
  const baseSnapshot = JSON.stringify(base);
  const nodesSnapshot = JSON.stringify(nodes);
  const out = withProviderNodeEntries(base, nodes);
  assert.notEqual(out, base);
  assert.equal(JSON.stringify(base), baseSnapshot);
  assert.equal(JSON.stringify(nodes), nodesSnapshot);
  assert.deepEqual(withProviderNodeEntries(base, null), base);
  assert.deepEqual(withProviderNodeEntries(base, undefined), base);
});

test("isTopologyEntryInSet matches Arc nodes by prefix, by node-id alias, case-insensitively", () => {
  const entries = withProviderNodeEntries([], NODES);
  const get = (key: string) => {
    const entry = entries.find((e) => e.provider === key);
    assert.ok(entry);
    return entry;
  };
  const active = new Set(["arc-embed", "arc-kokoro", "arc-whisper"]);
  assert.equal(isTopologyEntryInSet(get("arc-embed"), active), true);
  assert.equal(isTopologyEntryInSet(get("arc-kokoro"), active), true);
  assert.equal(isTopologyEntryInSet(get("arc-whisper"), active), true);
  assert.equal(isTopologyEntryInSet(get("ovms-arc"), active), false);
  // Audio requests addressed by node id emit provider = node row id.
  assert.equal(
    isTopologyEntryInSet(get("arc-whisper"), new Set([ARC_WHISPER_ID.toLowerCase()])),
    true
  );
  assert.equal(isTopologyEntryInSet({ provider: "Arc-Embed" }, new Set(["arc-embed"])), true);
  assert.equal(
    isTopologyEntryInSet({ provider: "x", aliases: ["NODE-ID"] }, new Set(["node-id"])),
    true
  );
  assert.equal(isTopologyEntryInSet(get("arc-embed"), new Set(["openai", "arc"])), false);
});

test("ProviderTopology uses alias-aware matching for active/last/error", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../src/app/(dashboard)/home/ProviderTopology.tsx", import.meta.url)),
    "utf8"
  );
  assert.match(src, /isTopologyEntryInSet\(p, activeSet\)/);
  assert.match(src, /isTopologyEntryInSet\(p, lastSet\)/);
  assert.match(src, /isTopologyEntryInSet\(p, errorSet\)/);
  assert.doesNotMatch(src, /activeSet\.has\(/);
});

test("HomePageClient merges provider-nodes into the topology list", () => {
  const src = readFileSync(
    fileURLToPath(
      new URL("../../src/app/(dashboard)/dashboard/HomePageClient.tsx", import.meta.url)
    ),
    "utf8"
  );
  assert.match(
    src,
    /withProviderNodeEntries\(Array\.from\(byProvider\.values\(\)\), providerNodes\)/
  );
});
