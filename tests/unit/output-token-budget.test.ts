import test from "node:test";
import assert from "node:assert/strict";

import { enforceOutputTokenBudget } from "../../open-sse/handlers/chatCore/outputTokenBudget.ts";

test("rejects a prompt that cannot leave one output token", () => {
  const result = enforceOutputTokenBudget({ max_tokens: 8192 }, 527_058, 128_000);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected the rejected output-budget branch");
  assert.equal(result.estimatedInputTokens, 527_058);
  assert.equal(result.contextLimit, 128_000);
  assert.deepEqual(result, {
    ok: false,
    estimatedInputTokens: 527_058,
    contextLimit: 128_000,
  });
});

test("caps a positive output budget to the target's remaining context", () => {
  const input = { messages: [], max_tokens: 12_000 };
  const result = enforceOutputTokenBudget(input, 127_000, 128_000);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body.max_tokens, 1_000);
  assert.equal(input.max_tokens, 12_000, "must not mutate the shared combo request body");
});

test("removes non-positive numeric output limits before upstream dispatch", () => {
  const result = enforceOutputTokenBudget(
    { max_tokens: -398_464, max_completion_tokens: 0 },
    1_000,
    128_000
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal("max_tokens" in result.body, false);
  assert.equal("max_completion_tokens" in result.body, false);
});

test("caps max_output_tokens to the target's remaining context", () => {
  const result = enforceOutputTokenBudget({ max_output_tokens: 12_000 }, 127_000, 128_000);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body.max_output_tokens, 1_000);
});

test("accepts a missing request body when output budget remains", () => {
  const result = enforceOutputTokenBudget(null, 1_000, 128_000);

  assert.deepEqual(result, {
    ok: true,
    body: {},
    availableOutputTokens: 127_000,
    adjustedFields: [],
  });
});

test("rejects when a Claude target's default output budget does not fit", () => {
  const result = enforceOutputTokenBudget({}, 70_000, 128_000, 64_000);

  assert.deepEqual(result, {
    ok: false,
    estimatedInputTokens: 70_000,
    contextLimit: 128_000,
  });
});

// ── Output reserve (window − requested-or-default max output) ───────────────

const { resolveOutputReserveTokens } =
  await import("../../open-sse/handlers/chatCore/outputTokenBudget.ts");

function withReserveEnv(value: string | undefined, fn: () => void) {
  const key = "OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS";
  const saved = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

test("a 57K-token request is admitted to a 131072-context target with the default reserve", () => {
  withReserveEnv(undefined, () => {
    const body = { messages: [] };
    const reserve = resolveOutputReserveTokens(body, 131_072, null);
    assert.equal(reserve, 16_384);
    const result = enforceOutputTokenBudget(body, 57_000, 131_072, 0, null, null, reserve);
    assert.equal(result.ok, true);
  });
});

test("input above window − default reserve is rejected and reports the reserve", () => {
  withReserveEnv(undefined, () => {
    const body = { messages: [] };
    const reserve = resolveOutputReserveTokens(body, 131_072, null);
    const result = enforceOutputTokenBudget(body, 120_000, 131_072, 0, null, null, reserve);
    assert.deepEqual(result, {
      ok: false,
      estimatedInputTokens: 120_000,
      contextLimit: 131_072,
      outputReserveTokens: 16_384,
    });
    // 131072 − 16384 = 114688 is the exact boundary.
    assert.equal(enforceOutputTokenBudget(body, 114_688, 131_072, 0, null, null, reserve).ok, true);
    assert.equal(
      enforceOutputTokenBudget(body, 114_689, 131_072, 0, null, null, reserve).ok,
      false
    );
  });
});

test("the client's own max output is the reserve when present", () => {
  withReserveEnv(undefined, () => {
    assert.equal(resolveOutputReserveTokens({ max_tokens: 4096 }, 131_072, null), 4096);
    assert.equal(
      resolveOutputReserveTokens({ max_tokens: 2048, max_completion_tokens: 6000 }, 131_072, null),
      6000
    );
    // Invalid client values fall back to the default.
    assert.equal(resolveOutputReserveTokens({ max_tokens: -1 }, 131_072, null), 16_384);
  });
});

test("the reserve is clamped to the model output cap and to window/4", () => {
  withReserveEnv(undefined, () => {
    assert.equal(resolveOutputReserveTokens({}, 131_072, 8192), 8192);
    assert.equal(resolveOutputReserveTokens({}, 32_768, null), 8192);
    assert.equal(resolveOutputReserveTokens({ max_tokens: 30_000 }, 32_768, null), 8192);
  });
});

test("OMNIROUTE_CONTEXT_OUTPUT_RESERVE_TOKENS=0 restores the legacy ≥1-token check", () => {
  withReserveEnv("0", () => {
    const reserve = resolveOutputReserveTokens({}, 131_072, null);
    assert.equal(reserve, 0);
    assert.equal(enforceOutputTokenBudget({}, 131_071, 131_072, 0, null, null, reserve).ok, true);
    assert.equal(enforceOutputTokenBudget({}, 131_072, 131_072, 0, null, null, reserve).ok, false);
  });
});

test("an omitted/null reserve is byte-identical to the legacy behavior", () => {
  const legacy = enforceOutputTokenBudget({ max_tokens: 10 }, 131_000, 131_072);
  const withNull = enforceOutputTokenBudget(
    { max_tokens: 10 },
    131_000,
    131_072,
    0,
    null,
    null,
    null
  );
  assert.deepEqual(withNull, legacy);
  assert.equal(legacy.ok, true);
});
