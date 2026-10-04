// GLM-5.3 on ds4 (llama-cpp connection) keeps a single live KV cache whose KDA layers
// cannot be rolled back, so any rewrite of already-sent history forces a full
// re-prefill. These tests drive two consecutive turns of one conversation through
// handleChatCore and assert the upstream payload of turn 2 starts with the exact
// bytes of turn 1: frozen memory text, untruncated earlier tool results, and
// forwarded reasoning_content.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-glm53-prefix-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { updateCompressionSettings } = await import("../../src/lib/db/compression.ts");
const { createMemory } = await import("../../src/lib/memory/store.ts");
const { invalidateMemorySettingsCache } = await import("../../src/lib/memory/settings.ts");
const { resetFrozenMemories } = await import("../../open-sse/handlers/chatCore/memoryFreeze.ts");
const core = await import("../../src/lib/db/core.ts");

type Msg = Record<string, unknown>;

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

function upstreamOk(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-x",
      object: "chat.completion",
      model: "ds4-glm53",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function sendTurn(opts: {
  provider: string;
  messages: Msg[];
  apiKeyId: string;
  sessionKey: string;
}): Promise<Msg[]> {
  const originalFetch = globalThis.fetch;
  let captured: Msg[] | null = null;
  globalThis.fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = init.body ? JSON.parse(String(init.body)) : null;
    captured = parsed?.messages ?? null;
    return upstreamOk();
  };
  try {
    const body = { model: "ds4-glm53", stream: false, messages: structuredClone(opts.messages) };
    await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: opts.provider, model: "ds4-glm53", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: noopLog,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json", "user-agent": "unit-test" }),
      },
      apiKeyInfo: { id: opts.apiKeyId, name: "Prefix Key" },
      userAgent: "unit-test",
      // chat.ts resolves this from session headers / first-user-message hash.
      sessionAffinityKey: opts.sessionKey,
    } as never);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, "upstream request was captured");
  return captured as Msg[];
}

const BIG_TOOL_RESULT = Array.from({ length: 900 }, (_, i) => `line ${i} of file`).join("\n");

function turn1(): Msg[] {
  return [
    { role: "system", content: "You are Zoo. Follow the rules." },
    { role: "user", content: "Read the file and summarize it." },
    {
      role: "assistant",
      content: "",
      reasoning_content: "I should read the file first.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: BIG_TOOL_RESULT },
  ];
}

function turn2(): Msg[] {
  return [
    ...turn1(),
    {
      role: "assistant",
      content: "",
      reasoning_content: "Now list the directory.",
      tool_calls: [
        { id: "call_2", type: "function", function: { name: "list_files", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_2", content: "a.ts\nb.ts" },
  ];
}

async function enableMemoryAndLite(apiKeyId: string): Promise<void> {
  await settingsDb.updateSettings({
    memoryEnabled: true,
    memoryMaxTokens: 1024,
    memoryRetentionDays: 30,
    memoryStrategy: "recent",
  });
  invalidateMemorySettingsCache();
  await updateCompressionSettings({
    enabled: true,
    defaultMode: "lite",
    autoTriggerTokens: 0,
    lite: { compressToolResults: true },
  } as never);
  await createMemory({
    apiKeyId,
    sessionId: "s",
    type: "factual",
    key: "pref-a",
    content: "User prefers terse answers.",
    metadata: {},
    expiresAt: null,
  } as never);
}

test.after(() => {
  try {
    core.getDbInstance().close();
  } catch {
    // best-effort
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("llama-cpp: turn 2 upstream payload starts with turn 1's exact bytes", async () => {
  resetFrozenMemories();
  const apiKeyId = `key-prefix-${Date.now()}`;
  await enableMemoryAndLite(apiKeyId);

  const first = await sendTurn({
    provider: "llama-cpp",
    messages: turn1(),
    apiKeyId,
    sessionKey: "zoo-task-1",
  });
  assert.match(String(first[0].content), /^Memory context: User prefers terse answers\./);

  // A newer memory would win a fresh "recent" retrieval and reorder the memory block.
  await createMemory({
    apiKeyId,
    sessionId: "s",
    type: "factual",
    key: "pref-b",
    content: "User works in Rust.",
    metadata: {},
    expiresAt: null,
  } as never);

  const second = await sendTurn({
    provider: "llama-cpp",
    messages: turn2(),
    apiKeyId,
    sessionKey: "zoo-task-1",
  });

  assert.ok(second.length > first.length);
  for (let i = 0; i < first.length; i++) {
    assert.equal(JSON.stringify(second[i]), JSON.stringify(first[i]), `message ${i} unchanged`);
  }
  // Memory frozen for the conversation: the newer memory is not injected.
  assert.doesNotMatch(String(second[0].content), /Rust/);
  // Earlier tool result was not truncated after a newer turn appeared.
  assert.equal(second[3].content, BIG_TOOL_RESULT);
  // reasoning_content forwarded unchanged on history turns.
  assert.equal(second[2].reasoning_content, "I should read the file first.");
  assert.equal(second[4].reasoning_content, "Now list the directory.");

  // A different conversation gets a fresh retrieval (and sees the newer memory).
  const other = await sendTurn({
    provider: "llama-cpp",
    messages: turn1(),
    apiKeyId,
    sessionKey: "zoo-task-2",
  });
  assert.match(String(other[0].content), /Rust/);
});

test("non-sensitive provider keeps today's Lite truncation of earlier tool results", async () => {
  resetFrozenMemories();
  const apiKeyId = `key-control-${Date.now()}`;
  await enableMemoryAndLite(apiKeyId);
  const second = await sendTurn({
    provider: "openai",
    messages: turn2(),
    apiKeyId,
    sessionKey: "control-task",
  });
  const earlierTool = second.find((m) => m.role === "tool" && m.tool_call_id === "call_1");
  assert.ok(earlierTool);
  assert.match(String(earlierTool.content), /\.\.\.\[truncated\]$/);
});
