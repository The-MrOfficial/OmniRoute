/**
 * Chunked embedding for long memory texts (memory writes, retrieval queries,
 * reindex, Qdrant upsert/search).
 *
 * After a Zoo condense the retrieval query is a `## Conversation Summary…`
 * block that easily passes 20k chars. Sent as one input, that is one long
 * OVMS inference on the Arc iGPU, which can trip the GPU watchdog and wedge
 * the embed server. Instead the text is split into chunks of at most
 * MAX_EMBED_CHUNK_CHARS (12k chars ≈ ≤4,000 tokens at the conservative 3
 * chars/token estimate, under the 4096-token per-item cap in
 * embeddingBatchSplit.ts) and each chunk is embedded as its own request.
 *
 * Data model: one vector per memory (vec_memories and Qdrant both key one
 * vector by memory id), so chunk vectors are mean-pooled — each L2-normalized,
 * averaged, renormalized — rather than stored per chunk. Queries go through the
 * same path, so stored and query vectors share a space. Per-chunk storage would
 * need a schema change, score aggregation, and a reindex.
 *
 * Text that fits in one chunk takes the exact previous path and its raw vector
 * is returned unchanged, so existing stored vectors stay valid with no reindex.
 * At most MAX_EMBED_CHUNKS chunks are embedded (36k chars); the rest is
 * dropped, replacing the previous 20k clip, and chat-path latency stays bounded
 * at three sequential calls.
 *
 * Splitting is char-based (no tokenizer helper exists). Boundaries prefer, in
 * order: the last paragraph break (`\n\n`), the last line break, the last
 * whitespace within the back half of the window, then a hard cut.
 */

export const MAX_EMBED_CHUNK_CHARS = 12_000;
export const MAX_EMBED_CHUNKS = 3;

/** End offset (exclusive) of the next chunk starting at `start`. */
function findChunkEnd(text: string, start: number, maxChars: number): number {
  const hardEnd = start + maxChars;
  if (hardEnd >= text.length) return text.length;
  const minEnd = start + Math.floor(maxChars / 2);
  const window = text.slice(start, hardEnd);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= 0 && start + paragraph + 2 > minEnd) return start + paragraph + 2;
  const line = window.lastIndexOf("\n");
  if (line >= 0 && start + line + 1 > minEnd) return start + line + 1;
  const space = window.search(/\s\S*$/);
  if (space >= 0 && start + space + 1 > minEnd) return start + space + 1;
  return hardEnd;
}

/**
 * Split `text` into at most `maxChunks` chunks of at most `maxChars` chars.
 * Chunks concatenate back to the first `maxChars × maxChunks` chars of the
 * text (boundary whitespace stays at the end of the earlier chunk); a chunk
 * that would be whitespace-only is dropped.
 */
export function chunkTextForEmbedding(
  text: string,
  maxChars = MAX_EMBED_CHUNK_CHARS,
  maxChunks = MAX_EMBED_CHUNKS
): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    const end = findChunkEnd(text, start, maxChars);
    const chunk = text.slice(start, end);
    if (chunk.trim().length > 0) chunks.push(chunk);
    start = end;
  }
  return chunks.length > 0 ? chunks : [text.slice(0, maxChars)];
}

function l2Normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return new Float32Array(vector);
  return vector.map((value) => value / norm);
}

/** Mean of L2-normalized vectors, renormalized to unit length. */
export function meanPoolVectors(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error("meanPoolVectors: no vectors to pool");
  const dimensions = vectors[0].length;
  const sum = new Float32Array(dimensions);
  for (const vector of vectors) {
    if (vector.length !== dimensions) {
      throw new Error(`meanPoolVectors: dimension mismatch (${vector.length} vs ${dimensions})`);
    }
    const normalized = l2Normalize(vector);
    for (let index = 0; index < dimensions; index++) sum[index] += normalized[index];
  }
  return l2Normalize(sum.map((value) => value / vectors.length));
}

/**
 * Embed `text` chunk by chunk. A single-chunk text calls `embedOne(text)` once
 * and returns its result unchanged. Otherwise chunks are embedded sequentially
 * (one input per request); the first non-vector result is returned as-is and
 * the remaining chunks are not sent. Thrown errors propagate.
 */
export async function embedTextChunked<E>(
  text: string,
  embedOne: (chunk: string) => Promise<Float32Array | E>,
  isVector: (result: Float32Array | E) => result is Float32Array
): Promise<Float32Array | E> {
  const chunks = chunkTextForEmbedding(text);
  if (chunks.length === 1 && chunks[0] === text) return embedOne(text);
  const vectors: Float32Array[] = [];
  for (const chunk of chunks) {
    const result = await embedOne(chunk);
    if (!isVector(result)) return result;
    vectors.push(result);
  }
  return meanPoolVectors(vectors);
}
