import test from "node:test";
import assert from "node:assert/strict";

// After a Zoo condense the memory retrieval query is a ~20k-char "## Conversation Summary"
// block. Sent as one input it is one long OVMS inference that can trip the Arc GPU watchdog.
// The memory embedder now splits it into ≤12k-char chunks (one request each) and
// mean-pools the chunk vectors into the single vector the memory data model stores.

const chunking = await import("../../src/lib/memory/embedding/chunking.ts");
const { embedRemote } = await import("../../src/lib/memory/embedding/remote.ts");
type RequestFn = NonNullable<Parameters<typeof embedRemote>[3]>;

function buildSummary(totalChars: number): string {
  const paragraphs: string[] = ["## Conversation Summary"];
  let length = paragraphs[0].length;
  for (let n = 0; length < totalChars; n++) {
    const paragraph = `${n}. ${"word ".repeat(120)}`.slice(0, 600);
    paragraphs.push(paragraph);
    length += paragraph.length + 2;
  }
  return paragraphs.join("\n\n").slice(0, totalChars);
}

function norm(vector: Float32Array): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

interface FakeCall {
  input: unknown;
  options: unknown;
}

/** Fake createEmbeddingResponse: vector [1, chunkIndex] per call, or a status from `failOn`. */
function fakeRequest(failOn?: (call: number) => number | null) {
  const calls: FakeCall[] = [];
  const requestFn: RequestFn = async (body, options) => {
    calls.push({ input: body.input, options });
    const failStatus = failOn?.(calls.length) ?? null;
    if (failStatus) return new Response("boom", { status: failStatus });
    return new Response(JSON.stringify({ data: [{ embedding: [1, calls.length - 1, 0] }] }), {
      status: 200,
    });
  };
  return { calls, requestFn };
}

test("a 20k-char summary splits into ≤12k chunks on paragraph boundaries", () => {
  const summary = buildSummary(20_000);
  assert.equal(summary.length, 20_000);
  const chunks = chunking.chunkTextForEmbedding(summary);
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
  for (const chunk of chunks) assert.ok(chunk.length <= 12_000, `chunk of ${chunk.length}`);
  for (const chunk of chunks.slice(0, -1)) assert.ok(chunk.endsWith("\n\n"));
  assert.equal(chunks.join(""), summary);
});

test("a 50k-char text is capped at 3 chunks", () => {
  const text = buildSummary(50_000);
  const chunks = chunking.chunkTextForEmbedding(text);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(""), text.slice(0, chunks.join("").length));
  assert.ok(chunks.join("").length <= 36_000);
});

test("no newlines splits at whitespace; no whitespace hard-cuts at 12k", () => {
  const spaced = "word ".repeat(5000);
  const spacedChunks = chunking.chunkTextForEmbedding(spaced);
  assert.ok(spacedChunks.length >= 2);
  assert.ok(spacedChunks[0].endsWith(" "));
  assert.ok(spacedChunks[0].length <= 12_000);
  assert.equal(spacedChunks.join(""), spaced);

  const solid = "x".repeat(20_000);
  const solidChunks = chunking.chunkTextForEmbedding(solid);
  assert.deepEqual(
    solidChunks.map((chunk) => chunk.length),
    [12_000, 8000]
  );
});

test("a text of at most 12k chars is one chunk", () => {
  const text = buildSummary(12_000);
  assert.deepEqual(chunking.chunkTextForEmbedding(text), [text]);
});

test("meanPoolVectors: unit-norm mean of normalized vectors; rejects dimension mismatch", () => {
  const pooled = chunking.meanPoolVectors([new Float32Array([3, 0]), new Float32Array([0, 5])]);
  assert.ok(Math.abs(norm(pooled) - 1) < 1e-6);
  assert.ok(Math.abs(pooled[0] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(pooled[1] - Math.SQRT1_2) < 1e-6);
  assert.throws(() => chunking.meanPoolVectors([new Float32Array(2), new Float32Array(3)]));
  assert.throws(() => chunking.meanPoolVectors([]));
});

test("embedRemote embeds every chunk of a 20k summary and returns the pooled vector", async () => {
  const summary = buildSummary(20_000);
  const { calls, requestFn } = fakeRequest();
  const result = await embedRemote(summary, "arc-embed/qwen3-embedding-0.6b", null, requestFn);
  const expectedChunks = chunking.chunkTextForEmbedding(summary);
  assert.equal(calls.length, expectedChunks.length);
  assert.ok(calls.length >= 2);
  assert.deepEqual(
    calls.map((call) => call.input),
    expectedChunks
  );
  for (const call of calls) assert.ok(String(call.input).length <= 12_000);
  assert.ok("vector" in result);
  const expected = chunking.meanPoolVectors(
    expectedChunks.map((_chunk, index) => new Float32Array([1, index, 0]))
  );
  assert.deepEqual(Array.from(result.vector), Array.from(expected));
  assert.equal(result.dimensions, 3);
});

test("embedRemote sends a short text once, unchanged, flagged internal", async () => {
  const { calls, requestFn } = fakeRequest();
  const result = await embedRemote(
    "short query",
    "arc-embed/qwen3-embedding-0.6b",
    null,
    requestFn
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "short query");
  assert.deepEqual(calls[0].options, { internalCaller: true });
  assert.ok("vector" in result);
  assert.deepEqual(Array.from(result.vector), [1, 0, 0]);
});

test("embedRemote stops at the first failing chunk and reports its status", async () => {
  const summary = buildSummary(30_000);
  assert.equal(chunking.chunkTextForEmbedding(summary).length, 3);
  const { calls, requestFn } = fakeRequest((call) => (call === 2 ? 503 : null));
  const result = await embedRemote(summary, "arc-embed/qwen3-embedding-0.6b", null, requestFn);
  assert.equal(calls.length, 2);
  assert.ok(!("vector" in result));
  assert.equal(result.reason, "request_failed");
  assert.equal(result.status, 503);
});
