// Black-box regression for the RTX 5090 pre-flight rejection (hybrid/code → pool/tier1/code
// step code-t1-0, vllm/qwen3.8-27b-nvfp4, 131072 window, max_input_tokens override 98304).
//
// The final input gate in handleChatCore estimated a Zoo Code agent request at ~130K
// tokens (real: 53,976 per vLLM /tokenize) because it counted historical assistant
// reasoning_content that the translator strips for this target, and it ignored the
// combo's weightedTargetPolicies maxInputTokens. Requests fell through to the 4070 Ti
// and cloud Bedrock while the 5090 sat idle.
//
// These tests drive the public handleChatCore with a temp DB and a fetch stub and
// assert on the dispatch signal (did the upstream fetch fire / was it a 400).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildZooLikeBody } from "./fixtures/zooLikeBody.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-preflight-reasoning-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
const capabilityOverrides = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const compressionDb = await import("../../src/lib/db/compression.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");

const VLLM = { provider: "vllm", model: "qwen3.8-27b-nvfp4" };
const LLAMA = { provider: "llama-cpp", model: "ds4-glm53" };

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
let infoLines: string[] = [];
let warnLines: string[] = [];
const captureLog = {
  debug() {},
  info(tag: unknown, message: unknown) {
    infoLines.push(`${String(tag)} ${String(message)}`);
  },
  warn(tag: unknown, message: unknown) {
    warnLines.push(`${String(tag)} ${String(message)}`);
  },
  error() {},
};

function buildRequest(
  target: { provider: string; model: string },
  body: Record<string, unknown>,
  combo: { isCombo: boolean; comboName?: string | null } = { isCombo: false }
) {
  const requestBody = { ...body, model: target.model, stream: false };
  return {
    body: requestBody,
    modelInfo: { provider: target.provider, model: target.model, extendedContext: false },
    credentials: {
      apiKey: "sk-test",
      providerSpecificData: { baseUrl: "https://preflight-reasoning.example.test/v1" },
    },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: requestBody,
      headers: new Headers({ accept: "application/json" }),
    },
    userAgent: "unit-test",
    isCombo: combo.isCombo,
    comboName: combo.comboName ?? null,
    log: captureLog,
  };
}

/** Plain (non-reasoning) conversation sized to ~`tokens` chars/4 tokens. */
function plainBody(tokens: number) {
  const perMessage = 4_000;
  const count = Math.ceil((tokens * 4) / perMessage);
  return {
    messages: [
      { role: "system", content: "You are a coding agent." },
      ...Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn ${index} ` + "lorem ipsum dolor sit amet ".repeat(perMessage / 27),
      })),
      { role: "user", content: "continue" },
    ],
  };
}

test.before(async () => {
  core.resetDbInstance();
  // Compression off: the gate decision must be observable without compaction.
  await compressionDb.updateCompressionSettings({
    enabled: false,
    defaultMode: "off",
    autoTriggerTokens: 0,
  } as never);
  for (const target of [VLLM, LLAMA]) {
    assert.equal(
      contextOverrides.setModelContextOverride(target.provider, target.model, 131_072),
      true
    );
  }
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(
      `${VLLM.provider}/${VLLM.model}`,
      "max_input_tokens",
      98_304
    ),
    true
  );
  // context_length values mirror the live combos: the dispatching combo declares a
  // 262144 window, larger than the 5090's real 131072 — the policy cap must still be
  // bounded by the target's own window.
  await combosDb.createCombo({
    name: "pool/tier1/code",
    strategy: "priority",
    context_length: 163_840,
    models: [
      {
        id: "code-t1-0",
        kind: "model",
        model: `${VLLM.provider}/${VLLM.model}`,
        providerId: "vllm",
      },
    ],
    config: {
      weightedTargetPolicies: {
        [`${VLLM.provider}/${VLLM.model}`]: { capacityUnits: 1, maxInputTokens: 524_288 },
      },
    },
  } as never);
  await combosDb.createCombo({
    name: "hybrid/code",
    strategy: "priority",
    context_length: 262_144,
    models: [{ id: "hybrid-code-tier1", kind: "combo-ref", comboName: "pool/tier1/code" }],
    config: {},
  } as never);
  globalThis.fetch = async (url: RequestInfo | URL) => {
    if (String(url instanceof Request ? url.url : url).includes("/__omniroute_event")) {
      return new Response(null, { status: 204 });
    }
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        id: "chatcmpl-preflight",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.beforeEach(() => {
  fetchCalls = 0;
  infoLines = [];
  warnLines = [];
});

test("Zoo-like ~54K-real request with 289K chars of reasoning reaches the 5090", async () => {
  const result = await handleChatCore(buildRequest(VLLM, buildZooLikeBody()));
  assert.notEqual(result.status, 400, warnLines.join("\n"));
  assert.ok(fetchCalls > 0, "the request must reach the upstream fetch");
  assert.equal(
    warnLines.some((line) => line.includes("Input exceeds")),
    false,
    "no pre-flight rejection"
  );
});

test("a ~57K-real request is admitted to the 131072-context target", async () => {
  const result = await handleChatCore(
    buildRequest(VLLM, buildZooLikeBody({ scale: 57_000 / 53_976 }))
  );
  assert.notEqual(result.status, 400, warnLines.join("\n"));
  assert.ok(fetchCalls > 0);
});

test("the combo per-target policy (524288) is honored over the 98304 override", async () => {
  // ~105K estimate: above the 98304 override, below 131072 − 16384 = 114688.
  const body = plainBody(95_000);
  const direct = await handleChatCore(buildRequest(VLLM, body));
  assert.equal(direct.status, 400, "direct request keeps the 98304 override");
  assert.equal(fetchCalls, 0);
  assert.match(JSON.stringify(direct), /maximum input tokens/i);

  const viaCombo = await handleChatCore(
    buildRequest(VLLM, body, { isCombo: true, comboName: "hybrid/code" })
  );
  assert.notEqual(viaCombo.status, 400, warnLines.join("\n"));
  assert.ok(fetchCalls > 0, "combo request admitted via the pool/tier1/code policy");
});

test("a genuinely oversized request is still rejected, with the info breakdown", async () => {
  const result = await handleChatCore(
    buildRequest(VLLM, plainBody(140_000), { isCombo: true, comboName: "hybrid/code" })
  );
  assert.equal(result.status, 400);
  assert.equal(fetchCalls, 0, "rejected request never reaches upstream");
  assert.match(JSON.stringify(result), /context_length_exceeded/);
  const breakdown = infoLines.find((line) => line.includes("Pre-flight rejected vllm/"));
  assert.ok(breakdown, `info breakdown logged; got:\n${infoLines.join("\n")}`);
  for (const part of [
    "messages",
    "tools",
    "reasoning",
    "stripped",
    "margin",
    "cap",
    "output reserve",
  ]) {
    assert.ok(breakdown.includes(part), `breakdown mentions ${part}: ${breakdown}`);
  }
  assert.match(breakdown, /source combo-policy/);
});

test("a prefix-cache target that receives reasoning still counts it", async () => {
  // llama-cpp forwards reasoning_content verbatim, so the same Zoo-like body is
  // ~154K real tokens there and must be rejected for a 131072 window.
  const result = await handleChatCore(buildRequest(LLAMA, buildZooLikeBody()));
  assert.equal(result.status, 400);
  assert.equal(fetchCalls, 0);
  const breakdown = infoLines.find((line) => line.includes("Pre-flight rejected llama-cpp/"));
  assert.ok(breakdown, `info breakdown logged; got:\n${infoLines.join("\n")}`);
  assert.match(breakdown, /forwardReasoning true/);
  assert.doesNotMatch(breakdown, /reasoning 0 /);
});
