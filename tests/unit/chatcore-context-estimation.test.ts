import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateFinalInputTokenBreakdown,
  estimateFinalInputTokens,
} from "../../open-sse/handlers/chatCore/contextEstimation.ts";
import { estimateTokens } from "../../open-sse/services/contextManager.ts";

test("estimateFinalInputTokens counts nested request contents and auxiliary fields", () => {
  const contents = [{ role: "user", parts: [{ text: "nested Gemini request" }] }];
  const tools = [{ name: "lookup", description: "find a record" }];
  const body = {
    request: { contents },
    tools,
    system: "system prompt",
    instructions: 42,
  };

  assert.equal(
    estimateFinalInputTokens(body),
    estimateTokens(contents) +
      estimateTokens(tools) +
      estimateTokens(body.system) +
      estimateTokens(body.instructions)
  );
});

test("estimateFinalInputTokens ignores a malformed nested request and uses input", () => {
  const input = [{ role: "user", content: "fallback input" }];
  const body = {
    request: "not an object",
    input,
  };

  assert.equal(estimateFinalInputTokens(body), estimateTokens(input));
});

test("estimateFinalInputTokenBreakdown identifies auxiliary input after compression", () => {
  const body = {
    messages: [{ role: "user", content: "compressed message" }],
    tools: [{ name: "lookup", description: "tool schema" }],
    system: "system prompt",
    instructions: "instructions",
  };
  const breakdown = estimateFinalInputTokenBreakdown(body);

  assert.deepEqual(breakdown, {
    messages: estimateTokens(body.messages),
    tools: estimateTokens(body.tools),
    system: estimateTokens(body.system),
    instructions: estimateTokens(body.instructions),
    reasoning: 0,
    reasoningStripped: 0,
    margin: 1,
    rawTotal:
      estimateTokens(body.messages) +
      estimateTokens(body.tools) +
      estimateTokens(body.system) +
      estimateTokens(body.instructions),
    total:
      estimateTokens(body.messages) +
      estimateTokens(body.tools) +
      estimateTokens(body.system) +
      estimateTokens(body.instructions),
  });
  assert.equal(estimateFinalInputTokens(body), breakdown.total);
});

test("estimateTokens accepts the unknown JSON values it already serializes", () => {
  assert.equal(estimateTokens(true), 1);
  assert.equal(estimateTokens(42), 1);
  assert.equal(estimateTokens(undefined), 0);
});

// ── Reasoning-aware estimate, margin, and env tunables ──────────────────────

const {
  getContextEstimateMargin,
  getReasoningCharsPerToken,
  getContextOutputReserveTokens,
  DEFAULT_CONTEXT_ESTIMATE_MARGIN,
  DEFAULT_REASONING_CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS,
} = await import("../../open-sse/handlers/chatCore/contextEstimateConfig.ts");

const ENV_KEYS = [
  "OMNIROUTE_CONTEXT_ESTIMATE_MARGIN",
  "OMNIROUTE_CONTEXT_REASONING_CHARS_PER_TOKEN",
  "OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS",
] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void) {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function reasoningBody() {
  return {
    messages: [
      { role: "user", content: "u".repeat(400) },
      { role: "assistant", content: "a".repeat(400), reasoning_content: "r".repeat(2800) },
      { role: "user", content: "next" },
    ],
  };
}

test("env tunables default when unset", () => {
  withEnv({}, () => {
    assert.equal(getContextEstimateMargin(), DEFAULT_CONTEXT_ESTIMATE_MARGIN);
    assert.equal(getReasoningCharsPerToken(), DEFAULT_REASONING_CHARS_PER_TOKEN);
    assert.equal(getContextOutputReserveTokens(), DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS);
    assert.equal(DEFAULT_CONTEXT_ESTIMATE_MARGIN, 1.1);
    assert.equal(DEFAULT_REASONING_CHARS_PER_TOKEN, 2.8);
    assert.equal(DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS, 16384);
  });
});

test("env tunables accept valid values and fall back on invalid ones", () => {
  withEnv(
    {
      OMNIROUTE_CONTEXT_ESTIMATE_MARGIN: "1.25",
      OMNIROUTE_CONTEXT_REASONING_CHARS_PER_TOKEN: "3.5",
      OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS: "0",
    },
    () => {
      assert.equal(getContextEstimateMargin(), 1.25);
      assert.equal(getReasoningCharsPerToken(), 3.5);
      assert.equal(getContextOutputReserveTokens(), 0);
    }
  );
  for (const bad of ["0.5", "3", "abc", "-1"]) {
    withEnv(
      {
        OMNIROUTE_CONTEXT_ESTIMATE_MARGIN: bad,
        OMNIROUTE_CONTEXT_REASONING_CHARS_PER_TOKEN: bad === "3" ? "9" : bad,
        OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS: bad === "3" ? "1.5" : bad,
      },
      () => {
        assert.equal(getContextEstimateMargin(), DEFAULT_CONTEXT_ESTIMATE_MARGIN, `margin ${bad}`);
        assert.equal(getReasoningCharsPerToken(), DEFAULT_REASONING_CHARS_PER_TOKEN, `cpt ${bad}`);
        assert.equal(
          getContextOutputReserveTokens(),
          DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS,
          `reserve ${bad}`
        );
      }
    );
  }
});

test("stripped reasoning is excluded from the total and reported separately", () => {
  withEnv({}, () => {
    const body = reasoningBody();
    const legacy = estimateFinalInputTokenBreakdown(body);
    const stripped = estimateFinalInputTokenBreakdown(body, { forwardReasoning: false });
    assert.equal(stripped.reasoning, 0);
    assert.equal(stripped.reasoningStripped, 700); // 2800 chars / 4
    assert.ok(stripped.total < legacy.total - 650, "stripped reasoning no longer counted");
    assert.equal(stripped.total, stripped.rawTotal);
    // The body is not mutated.
    assert.equal(body.messages[1].reasoning_content, "r".repeat(2800));
  });
});

test("forwarded reasoning is counted at the denser reasoning ratio", () => {
  withEnv({}, () => {
    const body = reasoningBody();
    const stripped = estimateFinalInputTokenBreakdown(body, { forwardReasoning: false });
    const forwarded = estimateFinalInputTokenBreakdown(body, { forwardReasoning: true });
    assert.equal(forwarded.reasoning, 1000); // 2800 chars / 2.8
    assert.equal(forwarded.reasoningStripped, 0);
    assert.equal(forwarded.messages, stripped.messages);
    assert.equal(forwarded.total, stripped.total + 1000);
  });
});

test("the margin applies only when requested", () => {
  withEnv({}, () => {
    const body = reasoningBody();
    const plain = estimateFinalInputTokenBreakdown(body, { forwardReasoning: false });
    const margined = estimateFinalInputTokenBreakdown(body, {
      forwardReasoning: false,
      applyMargin: true,
    });
    assert.equal(plain.margin, 1);
    assert.equal(margined.margin, 1.1);
    assert.equal(margined.rawTotal, plain.total);
    assert.equal(margined.total, Math.ceil(plain.total * 1.1));
    assert.equal(
      estimateFinalInputTokens(body, { forwardReasoning: false, applyMargin: true }),
      margined.total
    );
  });
});

test("legacy mode (no options) keeps reasoning inline in messages at chars/4", () => {
  const body = reasoningBody();
  const legacy = estimateFinalInputTokenBreakdown(body);
  assert.equal(legacy.messages, estimateTokens(body.messages));
  assert.equal(legacy.reasoning, 0);
  assert.equal(legacy.margin, 1);
  assert.equal(legacy.total, estimateTokens(body.messages));
});
