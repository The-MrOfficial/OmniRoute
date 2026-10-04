import test from "node:test";
import assert from "node:assert/strict";

import {
  appendToolCallArgumentDelta,
  unwrapStringifiedToolArgFields,
} from "../../open-sse/utils/toolCallArguments.ts";

/**
 * Helper: reduce a list of incremental delta fragments the way the streaming
 * accumulators do (sseParser / responsesTransformer / translators).
 */
function accumulate(fragments: string[]): string {
  return fragments.reduce<string>((acc, frag) => appendToolCallArgumentDelta(acc, frag), "");
}

test("appendToolCallArgumentDelta concatenates incremental fragments verbatim", () => {
  assert.equal(accumulate(['{"q":"hel', 'lo"}']), '{"q":"hello"}');
});

test("appendToolCallArgumentDelta preserves repeated characters across fragment boundaries (#3701 anti-truncation)", () => {
  // The previous fuzzy-dedup heuristic dropped a byte here, turning the buffer's
  // trailing "x" + the next "x" into a single "x". Repeated chars must survive.
  assert.equal(accumulate(['{"a":"', "x", "x", '"}']), '{"a":"xx"}');
  // A shell command with a doubled letter must not be silently truncated
  // (`ls -ll` → `ls -l` was the real-world corruption).
  assert.equal(accumulate(['{"cmd":"l', 'l -l"}']), '{"cmd":"ll -l"}');
  // A doubled letter that straddles a single-char fragment boundary survives.
  assert.equal(accumulate(['{"path":"/a/bb', 'b/c"}']), '{"path":"/a/bbb/c"}');
});

test("appendToolCallArgumentDelta dedups an identical full-snapshot repeat", () => {
  const args = JSON.stringify({ command: "find /tmp -name test.txt" });
  assert.equal(appendToolCallArgumentDelta(args, args), args);
});

test("appendToolCallArgumentDelta replaces a growing full snapshot instead of concatenating", () => {
  assert.equal(appendToolCallArgumentDelta('{"a"', '{"a":1}'), '{"a":1}');
  assert.equal(
    appendToolCallArgumentDelta('{"command":"ec', '{"command":"echo hi"}'),
    '{"command":"echo hi"}'
  );
});

test("appendToolCallArgumentDelta handles empty / non-string inputs", () => {
  assert.equal(appendToolCallArgumentDelta("", "x"), "x");
  assert.equal(appendToolCallArgumentDelta("x", ""), "x");
  assert.equal(appendToolCallArgumentDelta(undefined, "x"), "x");
  assert.equal(appendToolCallArgumentDelta("x", undefined), "x");
  assert.equal(appendToolCallArgumentDelta(null, null), "");
  assert.equal(appendToolCallArgumentDelta(42, "x"), "x");
});

test("unwrapStringifiedToolArgFields un-stringifies a nested JSON-string array (GLM parallel_tasks)", () => {
  // Self-hosted llama.cpp GLM emits the tasks array as a quoted JSON string.
  const broken = JSON.stringify({
    tasks: JSON.stringify([
      { name: "spec-digest", mode: "project-research", message: "Read the spec." },
      { name: "impl", mode: "code", message: "Implement it." },
    ]),
  });
  const fixed = unwrapStringifiedToolArgFields(broken);
  const parsed = JSON.parse(fixed);
  assert.ok(Array.isArray(parsed.tasks), "tasks must become a real array");
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].name, "spec-digest");
  assert.ok(!fixed.includes('"[{'), "no residual stringified-array wrapping");
});

test("unwrapStringifiedToolArgFields un-stringifies a nested JSON-string object", () => {
  const broken = JSON.stringify({ payload: JSON.stringify({ a: 1, b: "two" }) });
  const parsed = JSON.parse(unwrapStringifiedToolArgFields(broken));
  assert.deepEqual(parsed.payload, { a: 1, b: "two" });
});

test("unwrapStringifiedToolArgFields leaves plain string fields untouched", () => {
  // A path/command/prose must NOT be coerced even though it is a string.
  const ok = JSON.stringify({ path: "/a/b/c.ts", command: "ls -ll", note: "[draft] see below" });
  assert.equal(unwrapStringifiedToolArgFields(ok), ok);
});

test("unwrapStringifiedToolArgFields is byte-identical passthrough for already-correct args", () => {
  const good = JSON.stringify({ tasks: [{ name: "x", mode: "code" }] });
  assert.equal(unwrapStringifiedToolArgFields(good), good);
});

test("unwrapStringifiedToolArgFields leaves incomplete/invalid JSON unchanged (streaming fragment)", () => {
  assert.equal(unwrapStringifiedToolArgFields('{"tasks":"[{"name"'), '{"tasks":"[{"name"');
  assert.equal(unwrapStringifiedToolArgFields(""), "");
  assert.equal(unwrapStringifiedToolArgFields("not json"), "not json");
});

test("unwrapStringifiedToolArgFields does not treat a non-object root as repairable", () => {
  const arr = JSON.stringify([{ name: "x" }]);
  assert.equal(unwrapStringifiedToolArgFields(arr), arr);
});

test("unwrapStringifiedToolArgFields returns empty string for non-string input", () => {
  assert.equal(unwrapStringifiedToolArgFields(undefined), "");
  assert.equal(unwrapStringifiedToolArgFields(null), "");
  assert.equal(unwrapStringifiedToolArgFields(42), "");
});
