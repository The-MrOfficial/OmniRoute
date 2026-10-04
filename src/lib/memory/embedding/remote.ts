import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { createEmbeddingResponse } from "@/lib/embeddings/service";
import type { EmbeddingResult, EmbeddingError } from "./types";
import type { ResolvedMemoryCustomEmbeddingProvider } from "./customProvider";
import { embedTextChunked } from "./chunking";

/**
 * Embed one memory text through OmniRoute's own /v1/embeddings path.
 *
 * Long texts (e.g. a post-condense `## Conversation Summary` retrieval query)
 * are split into ≤12k-char chunks, embedded one request per chunk, and
 * mean-pooled into one vector; see chunking.ts for the rationale. Requests are
 * flagged `internalCaller` so the per-item token cap truncates instead of
 * rejecting. No retries happen here: the first failing chunk's error is
 * returned and the remaining chunks are not sent.
 */
export async function embedRemote(
  text: string,
  model: string,
  customProvider: ResolvedMemoryCustomEmbeddingProvider | null = null,
  requestFn: typeof createEmbeddingResponse = createEmbeddingResponse
): Promise<EmbeddingResult | EmbeddingError> {
  const t0 = Date.now();
  const requestOptions = {
    internalCaller: true,
    ...(customProvider
      ? { resolvedProvider: customProvider.provider, resolvedModel: customProvider.model }
      : {}),
  };
  const fail = (
    reason: EmbeddingError["reason"],
    message: string,
    status?: number
  ): EmbeddingError => ({
    source: "remote",
    model,
    reason,
    message: sanitizeErrorMessage(message),
    ...(status !== undefined ? { status } : {}),
  });

  const embedOne = async (chunk: string): Promise<Float32Array | EmbeddingError> => {
    let resp: Response;
    try {
      resp = await requestFn({ model, input: chunk }, requestOptions);
    } catch (err: unknown) {
      // Network-level errors (ECONNREFUSED, AbortError, etc.)
      const isTimeout =
        err instanceof Error &&
        (err.name === "AbortError" || err.message.toLowerCase().includes("timeout"));
      return fail(
        isTimeout ? "timeout" : "request_failed",
        err instanceof Error ? err.message : String(err)
      );
    }
    if (!resp.ok) {
      const status = resp.status;
      if (status === 401 || status === 403) {
        return fail("no_key", `Embedding provider returned ${status}`, status);
      }
      if (status === 429) {
        return fail("rate_limited", `Embedding provider returned 429 (rate limited)`, status);
      }
      return fail("request_failed", `Embedding provider returned HTTP ${status}`, status);
    }
    let json: unknown;
    try {
      json = await resp.json();
    } catch (err: unknown) {
      return fail(
        "request_failed",
        err instanceof Error ? err.message : "Failed to parse embedding response"
      );
    }
    try {
      const data = (json as { data?: Array<{ embedding: number[] }> }).data;
      if (!Array.isArray(data) || data.length === 0 || !Array.isArray(data[0].embedding)) {
        return fail(
          "request_failed",
          "Unexpected embedding response shape: missing data[0].embedding"
        );
      }
      return new Float32Array(data[0].embedding);
    } catch (err: unknown) {
      return fail("request_failed", err instanceof Error ? err.message : "Embedding parse error");
    }
  };

  const result = await embedTextChunked(
    text,
    embedOne,
    (value): value is Float32Array => value instanceof Float32Array
  );
  if (!(result instanceof Float32Array)) return result;
  return {
    vector: result,
    source: "remote",
    model,
    dimensions: result.length,
    latencyMs: Date.now() - t0,
    cached: false,
  };
}
