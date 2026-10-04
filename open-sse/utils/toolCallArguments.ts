/**
 * Accumulate streamed tool-call `arguments` fragments without corrupting them.
 *
 * Providers stream tool-call arguments in one of two shapes:
 *   - Incremental deltas: each chunk carries only the NEW fragment. These must
 *     be concatenated verbatim — even when a fragment's leading bytes repeat the
 *     tail of what we already have (e.g. the doubled `l` in `ls -ll`).
 *   - Full snapshots: each chunk re-sends the ENTIRE accumulated arguments so
 *     far. Concatenating those would duplicate the payload (issue #3701).
 *
 * We only dedup the snapshot case when it is UNAMBIGUOUS: an identical repeat,
 * or a growing superset that still starts with everything seen so far. Every
 * other fragment is treated as an incremental delta and appended as-is.
 *
 * A fuzzy suffix/prefix-overlap heuristic must NOT be used here: it silently
 * drops bytes from legitimate incremental deltas (turning `ll` into `l`, `xx`
 * into `x`), which trades a visible duplication bug for a silent truncation bug.
 *
 * A third, non-conformant shape some upstreams emit (#6459): the FULL
 * `arguments` value delivered as an already-parsed JSON object/array instead
 * of a JSON-encoded string (violates the OpenAI streaming contract, but seen
 * from some Anthropic-shape-passthrough backends). Treating that as "not a
 * string" and silently discarding it left `tool_use.input` empty upstream —
 * or, when a caller re-serialized the buffer with plain string coercion
 * instead of JSON, rendered literally as `[object Object]` in the client
 * transcript. JSON.stringify it into a proper fragment instead of dropping it.
 */
function normalizeIncomingFragment(incoming: unknown): string {
  if (typeof incoming === "string") return incoming;
  if (incoming == null) return "";
  if (typeof incoming === "object") {
    try {
      return JSON.stringify(incoming);
    } catch {
      return "";
    }
  }
  return "";
}

export function appendToolCallArgumentDelta(current: unknown, incoming: unknown): string {
  const existing = typeof current === "string" ? current : "";
  const next = normalizeIncomingFragment(incoming);

  if (!existing) return next;
  if (!next) return existing;

  // Unambiguous snapshot repeat / growth — replace instead of concatenating.
  if (next === existing) return existing;
  if (next.startsWith(existing)) return next;

  // Incremental delta fragment — append verbatim (preserves repeated chars).
  return existing + next;
}

/**
 * Repair tool-call `arguments` whose nested fields were double-encoded as JSON
 * STRINGS instead of the real array/object the tool schema expects.
 *
 * Observed on self-hosted llama.cpp GLM (`llama-cpp/ds4-glm53`) emitting the
 * Zoo `parallel_tasks` tool call: it produces well-formed top-level arguments
 * but stringifies the nested array value, e.g.
 *
 *   {"tasks": "[{\"name\":\"spec-digest\",\"mode\":\"project-research\"}]"}
 *
 * instead of
 *
 *   {"tasks": [{"name":"spec-digest","mode":"project-research"}]}
 *
 * Downstream agents (Zoo 3.84.4) validate `nativeArgs.tasks` as an array and
 * reject the string ("missing nativeArgs / no valid tasks array"), so the
 * dispatch never runs even though the model DID emit a native tool_call. This
 * is a small/quantized-model structured-output quirk, not a transport bug.
 *
 * The repair is deliberately conservative — it must NEVER regress arguments
 * that already reach the client correctly:
 *   - Only acts when the complete `arguments` string parses to a plain object.
 *   - Only un-stringifies a field whose string value itself parses to an ARRAY
 *     or OBJECT (JSON that was wrapped one level too deep). A plain string
 *     value (a path, a command, prose) is left exactly as-is, even if it looks
 *     numeric/boolean, because collapsing those would change the tool input.
 *   - Returns the ORIGINAL string unchanged on any parse failure, non-object
 *     root, or when nothing needed unwrapping (byte-identical passthrough).
 *
 * @param argsString the fully-accumulated tool_call arguments JSON string
 * @returns the repaired JSON string, or the input unchanged when no safe repair
 */
export function unwrapStringifiedToolArgFields(argsString: unknown): string {
  if (typeof argsString !== "string") return "";
  const trimmed = argsString.trim();
  if (!trimmed.startsWith("{")) return argsString;

  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    return argsString; // incomplete/invalid JSON (e.g. a mid-stream fragment) — leave untouched.
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) return argsString;

  let changed = false;
  const obj = root as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value !== "string") continue;
    const inner = value.trim();
    // Only unwrap values that are themselves a JSON array/object. Never touch a
    // plain string field — un-stringifying a path or command would corrupt it.
    if (!(inner.startsWith("[") || inner.startsWith("{"))) continue;
    try {
      const parsedInner = JSON.parse(inner);
      if (parsedInner !== null && typeof parsedInner === "object") {
        obj[key] = parsedInner;
        changed = true;
      }
    } catch {
      // Not actually valid nested JSON — leave the string value as-is.
    }
  }

  if (!changed) return argsString;
  try {
    return JSON.stringify(obj);
  } catch {
    return argsString; // never emit a worse value than we received.
  }
}
