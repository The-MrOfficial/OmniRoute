// Unit coverage for the prefix-cache-sensitive gate (ds4/GLM-5.3 on llama-cpp):
// provider default + per-connection override, the Lite tool-result gate, the
// translator's reasoning_content passthrough, and the per-conversation memory freeze.
import test from "node:test";
import assert from "node:assert/strict";

const { isPrefixCacheSensitive, resolveConnectionCacheOverride } =
  await import("../../open-sse/utils/cacheControlPolicy.ts");
const { normalizeCacheOverride } = await import("../../src/lib/providers/requestDefaults.ts");
const { applyLiteCompression } = await import("../../open-sse/services/compression/lite.ts");
const { resolveCacheAwareConfig } =
  await import("../../open-sse/services/compression/cacheAwareConfig.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { freezeMemories, getFrozenMemories, resetFrozenMemories } =
  await import("../../open-sse/handlers/chatCore/memoryFreeze.ts");

type Msg = Record<string, unknown>;

test("isPrefixCacheSensitive: llama-cpp by default, connection override wins", () => {
  assert.equal(isPrefixCacheSensitive("llama-cpp"), true);
  assert.equal(isPrefixCacheSensitive("LlamaCpp"), true);
  assert.equal(isPrefixCacheSensitive("openai"), false);
  assert.equal(isPrefixCacheSensitive("vllm"), false);
  assert.equal(isPrefixCacheSensitive(null), false);
  assert.equal(isPrefixCacheSensitive("llama-cpp", { prefixCacheSensitive: false }), false);
  assert.equal(isPrefixCacheSensitive("vllm", { prefixCacheSensitive: true }), true);
});

test("isPrefixCacheSensitiveTarget: provider default, no DB read without connectionId", async () => {
  const { isPrefixCacheSensitiveTarget } =
    await import("../../open-sse/services/combo/executeTargetGates.ts");
  // No connectionId → resolved from the provider alone (a DB read would need DATA_DIR setup).
  assert.equal(await isPrefixCacheSensitiveTarget({ provider: "llama-cpp" }), true);
  assert.equal(await isPrefixCacheSensitiveTarget({ provider: "openai" }), false);
  assert.equal(await isPrefixCacheSensitiveTarget({ provider: null, connectionId: null }), false);
});

test("prefixCacheSensitive survives connection normalization and resolution", () => {
  assert.deepEqual(normalizeCacheOverride({ prefixCacheSensitive: true, junk: 1 }), {
    prefixCacheSensitive: true,
  });
  assert.equal(normalizeCacheOverride({ prefixCacheSensitive: "yes" }), undefined);
  assert.deepEqual(resolveConnectionCacheOverride({ cache: { prefixCacheSensitive: true } }), {
    prefixCacheSensitive: true,
  });
});

function historyWithBigTool(): { messages: Msg[] } {
  return {
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function" }] },
      { role: "tool", tool_call_id: "c1", content: "x ".repeat(3000).trim() },
      { role: "assistant", content: "next" },
      { role: "user", content: "again" },
    ],
  };
}

test("Lite skips tool-result truncation when config.prefixCacheSensitive is set", () => {
  const body = historyWithBigTool();
  const gated = applyLiteCompression(structuredClone(body), {
    compressToolResults: true,
    config: { prefixCacheSensitive: true },
  });
  const gatedMessages = gated.body.messages as Msg[];
  assert.equal(gatedMessages[2].content, (body.messages[2] as Msg).content);

  const ungated = applyLiteCompression(structuredClone(body), { compressToolResults: true });
  assert.match(String((ungated.body.messages as Msg[])[2].content), /\.\.\.\[truncated\]$/);
});

test("resolveCacheAwareConfig sets prefixCacheSensitive only for sensitive routes", () => {
  const base = {
    enabled: true,
    defaultMode: "lite",
    autoTriggerTokens: 0,
    cacheMinutes: 5,
    preserveSystemPrompt: true,
    comboOverrides: {},
  } as never;
  const body = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(
    resolveCacheAwareConfig(base, body, { provider: "llama-cpp" }).prefixCacheSensitive,
    true
  );
  assert.equal(
    resolveCacheAwareConfig(base, body, { provider: "openai" }).prefixCacheSensitive,
    undefined
  );
  assert.equal(
    resolveCacheAwareConfig(base, body, {
      provider: "llama-cpp",
      connectionCacheOverride: { prefixCacheSensitive: false },
    }).prefixCacheSensitive,
    undefined
  );
});

function reasoningHistory(): Msg {
  return {
    model: "ds4-glm53",
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "THINK1",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "r" },
      { role: "assistant", content: "done", reasoning_content: "THINK2" },
      { role: "user", content: "u2" },
    ],
  };
}

function reasoningOf(out: Msg): unknown[] {
  return (out.messages as Msg[]).map((m) => m.reasoning_content);
}

test("translator forwards history reasoning_content unchanged to llama-cpp", () => {
  const out = translateRequest(
    "openai",
    "openai",
    "ds4-glm53",
    structuredClone(reasoningHistory()),
    true,
    null,
    "llama-cpp"
  ) as Msg;
  assert.deepEqual(reasoningOf(out), [
    undefined,
    undefined,
    "THINK1",
    undefined,
    "THINK2",
    undefined,
  ]);
});

test("translator still strips reasoning_content for generic openai-compatible targets", () => {
  const out = translateRequest(
    "openai",
    "openai",
    "ds4-glm53",
    structuredClone(reasoningHistory()),
    true,
    null,
    "openai"
  ) as Msg;
  assert.deepEqual(reasoningOf(out), [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("memory freeze: hit per owner+conversation, idle expiry", () => {
  resetFrozenMemories();
  const mems = [{ id: "m1", content: "A" }] as never[];
  freezeMemories("owner", "conv", mems, 1000);
  assert.deepEqual(getFrozenMemories("owner", "conv", 2000), mems);
  assert.equal(getFrozenMemories("owner", "other", 2000), null);
  assert.equal(getFrozenMemories("other", "conv", 2000), null);
  // Empty retrievals are frozen too, so memory never appears mid-conversation.
  freezeMemories("owner", "empty", [], 1000);
  assert.deepEqual(getFrozenMemories("owner", "empty", 2000), []);
  // 6h idle TTL.
  assert.equal(getFrozenMemories("owner", "conv", 2000 + 6 * 60 * 60 * 1000 + 1), null);
  resetFrozenMemories();
});
