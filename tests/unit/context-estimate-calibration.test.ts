// Calibration of the pre-flight input-token estimate against measured ground truth.
//
// The fixture reproduces the shape and per-component JSON sizes of a real Zoo Code
// request that the RTX 5090 (vllm/qwen3.8-27b-nvfp4) gate rejected as ~130K tokens
// while its own tokenizer counted 53,976 (see tests/unit/fixtures/zooLikeBody.ts for
// the method). 64% of the body is historical assistant reasoning_content, which the
// translator strips for that target — the old estimate counted it anyway.
import test from "node:test";
import assert from "node:assert/strict";

import {
  REAL_TOKENS_FULL,
  REAL_TOKENS_NO_TOOLS,
  REAL_TOKENS_REASONING_RENDERED,
  ZOO_COMPONENT_CHARS,
  buildZooLikeBody,
  measureZooLikeBody,
} from "./fixtures/zooLikeBody.ts";

const { estimateFinalInputTokens } =
  await import("../../open-sse/handlers/chatCore/contextEstimation.ts");

const TOLERANCE = 0.15;

function assertWithin(estimate: number, real: number, label: string) {
  const ratio = estimate / real;
  assert.ok(
    ratio >= 1 - TOLERANCE && ratio <= 1 + TOLERANCE,
    `${label}: estimate ${estimate} vs real ${real} (${((ratio - 1) * 100).toFixed(1)}%) is outside ±15%`
  );
}

test("fixture reproduces the measured request shape (self-check)", () => {
  const measured = measureZooLikeBody(buildZooLikeBody());
  assert.equal(measured.messageCount, 113);
  assert.equal(measured.assistantReasoningTurns, 26);
  assert.equal(measured.reasoning, ZOO_COMPONENT_CHARS.reasoning);
  for (const key of ["messages", "tools"] as const) {
    const drift = Math.abs(measured[key] - ZOO_COMPONENT_CHARS[key]) / ZOO_COMPONENT_CHARS[key];
    assert.ok(drift < 0.01, `${key}: ${measured[key]} drifts ${drift} from the real body`);
  }
});

test("stripped-reasoning admission estimate is within ±15% of real and biased high", () => {
  const estimate = estimateFinalInputTokens(buildZooLikeBody(), {
    forwardReasoning: false,
    applyMargin: true,
  });
  assertWithin(estimate, REAL_TOKENS_FULL, "full body");
  assert.ok(
    estimate >= REAL_TOKENS_FULL * 0.97,
    `estimate ${estimate} should not under-count ${REAL_TOKENS_FULL}`
  );
});

test("no-tools variant is also within ±15% of real", () => {
  const estimate = estimateFinalInputTokens(buildZooLikeBody({ includeTools: false }), {
    forwardReasoning: false,
    applyMargin: true,
  });
  assertWithin(estimate, REAL_TOKENS_NO_TOOLS, "no tools");
});

test("forwarded-and-rendered reasoning is counted densely enough", () => {
  const estimate = estimateFinalInputTokens(buildZooLikeBody(), {
    forwardReasoning: true,
    applyMargin: true,
  });
  assert.ok(
    estimate >= REAL_TOKENS_REASONING_RENDERED * 0.85,
    `forwarded estimate ${estimate} under-counts rendered reasoning (${REAL_TOKENS_REASONING_RENDERED})`
  );
  assertWithin(estimate, REAL_TOKENS_REASONING_RENDERED, "reasoning rendered");
});

test("pre-fix (legacy) estimate exceeded the 5090's 98304 input cap — the bug", () => {
  const legacy = estimateFinalInputTokens(buildZooLikeBody());
  assert.ok(legacy > 98_304, `legacy estimate ${legacy} should reproduce the over-count`);
  assert.ok(legacy > REAL_TOKENS_FULL * 2, "legacy estimate is >2x the real prompt");
});
