/**
 * Shared audio/speech HTTP response helpers.
 *
 * Extracted from `open-sse/handlers/audioSpeech.ts` so that both the handler
 * and any provider-specific adapter modules extracted alongside it (e.g.
 * `open-sse/executors/awsPollyTts.ts`) can share the same response-shaping
 * logic without importing from the (frozen, file-size-ratcheted) handler
 * itself — which would create a circular import.
 */
import { CORS_HEADERS } from "./cors.ts";

/**
 * Pull a human-readable error message out of a parsed upstream JSON error body.
 */
function extractUpstreamErrorMessage(parsed) {
  const detail = parsed?.detail;
  const candidates = [
    parsed?.err_msg,
    parsed?.error?.message,
    typeof parsed?.error === "string" ? parsed.error : null,
    parsed?.message,
    typeof detail === "string" ? detail : detail?.message,
  ];

  const raw = candidates.find(Boolean);
  return raw ? String(raw) : null;
}

/**
 * Return a CORS error response from an upstream fetch failure.
 */
export function upstreamErrorResponse(res: Response, errText: string): Response {
  // Always return JSON so the client can detect 401/credential errors reliably
  let errorMessage: string;
  try {
    const parsed = JSON.parse(errText);
    errorMessage =
      extractUpstreamErrorMessage(parsed) || errText || `Upstream error (${res.status})`;
  } catch {
    errorMessage = errText || `Upstream error (${res.status})`;
  }

  return Response.json(
    { error: { message: errorMessage, code: res.status } },
    {
      status: res.status,
      headers: { ...CORS_HEADERS },
    }
  );
}

const SPEECH_FORMAT_MIME_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

/** MIME type for an OpenAI `response_format` value (mp3 when unknown). */
export function speechFormatMimeType(format: unknown): string {
  const key = typeof format === "string" ? format.toLowerCase() : "";
  return SPEECH_FORMAT_MIME_TYPES[key] ?? "audio/mpeg";
}

/** Audio MIME type from container magic bytes, or null when unrecognised. */
export function sniffAudioMimeType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (bytes.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg";
  if (bytes.length >= 4 && ascii(0, 4) === "fLaC") return "audio/flac";
  if (bytes.length >= 3 && ascii(0, 3) === "ID3") return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff) {
    // ADTS AAC sync (layer bits 00) vs MPEG audio frame sync.
    if ((bytes[1] & 0xf6) === 0xf0) return "audio/aac";
    if ((bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  }
  return null;
}

/**
 * Return a CORS audio stream response.
 *
 * The upstream Content-Type is kept only when it is an `audio/*` type. Some
 * OpenAI-compatible servers (OpenVINO Model Server) send 200 audio bodies as
 * `application/json` and ignore `response_format`, so the first chunk is
 * sniffed for its container and `defaultContentType` is the last resort.
 */
export async function audioStreamResponse(
  res: Response,
  defaultContentType = "audio/mpeg"
): Promise<Response> {
  const upstreamType = res.headers.get("content-type") || "";
  let contentType = upstreamType;
  let body: ReadableStream<Uint8Array> | null = res.body;
  if (!/^audio\//i.test(upstreamType)) {
    contentType = defaultContentType;
    if (body) {
      const reader = body.getReader();
      const first = await reader.read();
      const head = first.done ? new Uint8Array() : first.value;
      contentType = sniffAudioMimeType(head) ?? defaultContentType;
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (head.length > 0) controller.enqueue(head);
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    }
  }
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Transfer-Encoding": "chunked",
    },
  });
}
