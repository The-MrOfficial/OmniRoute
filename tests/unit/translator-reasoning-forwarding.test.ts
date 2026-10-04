// willForwardAssistantReasoning is the single strip/forward predicate shared by
// translateRequest and the pre-flight context estimator. These tests pin its
// verdict for the targets that matter for the 5090 admission bug, and prove the
// predicate agrees with what translateRequest actually does on the wire.
import test from "node:test";
import assert from "node:assert/strict";

const { willForwardAssistantReasoning } =
  await import("../../open-sse/translator/reasoningForwarding.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

function historyBody(extra: Record<string, unknown> = {}) {
  return {
    messages: [
      { role: "user", content: "fix the build" },
      {
        role: "assistant",
        content: "Looking at it.",
        reasoning_content: "The build fails because the import path is wrong.",
      },
      { role: "user", content: "go on" },
    ],
    ...extra,
  };
}

test("vllm/qwen3.8-27b-nvfp4 (OpenAI target, non-reasoner) does not receive reasoning", () => {
  assert.equal(
    willForwardAssistantReasoning({
      provider: "vllm",
      model: "qwen3.8-27b-nvfp4",
      targetFormat: FORMATS.OPENAI,
      body: historyBody(),
    }),
    false
  );
});

test("bedrock/qwen.qwen3-coder-next (OpenAI target) does not receive reasoning", () => {
  assert.equal(
    willForwardAssistantReasoning({
      provider: "bedrock",
      model: "qwen.qwen3-coder-next",
      targetFormat: FORMATS.OPENAI,
      body: historyBody(),
    }),
    false
  );
});

test("llama-cpp/ds4-glm53 (prefix-cache sensitive) forwards reasoning", () => {
  assert.equal(
    willForwardAssistantReasoning({
      provider: "llama-cpp",
      model: "ds4-glm53",
      targetFormat: FORMATS.OPENAI,
      body: historyBody(),
    }),
    true
  );
});

test("per-connection prefixCacheSensitive override forwards reasoning on vllm", () => {
  assert.equal(
    willForwardAssistantReasoning({
      provider: "vllm",
      model: "qwen3.8-27b-nvfp4",
      targetFormat: FORMATS.OPENAI,
      body: historyBody(),
      credentials: { providerSpecificData: { cache: { prefixCacheSensitive: true } } },
    }),
    true
  );
});

test("deepseek/deepseek-v4-flash with thinking (reasoning replay target) forwards reasoning", () => {
  assert.equal(
    willForwardAssistantReasoning({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      targetFormat: FORMATS.OPENAI,
      body: historyBody({ reasoning_effort: "high" }),
    }),
    true
  );
});

test("non-OpenAI target formats are treated as forwarding (conservative)", () => {
  assert.equal(
    willForwardAssistantReasoning({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      targetFormat: FORMATS.CLAUDE,
      body: historyBody(),
    }),
    true
  );
});

test("predicate agrees with translateRequest's strip/forward on the wire", () => {
  const cases = [
    { provider: "vllm", model: "qwen3.8-27b-nvfp4", body: historyBody() },
    { provider: "llama-cpp", model: "ds4-glm53", body: historyBody() },
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      body: historyBody({ reasoning_effort: "high" }),
    },
  ];
  for (const { provider, model, body } of cases) {
    const predicted = willForwardAssistantReasoning({
      provider,
      model,
      targetFormat: FORMATS.OPENAI,
      body,
    });
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      model,
      structuredClone(body),
      false,
      null,
      provider
    ) as { messages: Array<Record<string, unknown>> };
    const assistant = translated.messages.find((message) => message.role === "assistant");
    assert.ok(assistant, `${provider}: assistant turn survives translation`);
    assert.equal(
      typeof assistant.reasoning_content === "string" && assistant.reasoning_content.length > 0,
      predicted,
      `${provider}/${model}: predicate (${predicted}) must match the translated wire body`
    );
  }
});
