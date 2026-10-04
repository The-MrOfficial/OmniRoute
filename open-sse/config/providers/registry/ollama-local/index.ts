import type { RegistryEntry } from "../../shared.ts";

export const ollama_localProvider: RegistryEntry = {
  id: "ollama-local",
  alias: "ollama",
  format: "openai",
  executor: "default",
  // authType: "apikey", NOT "optional" (review Finding 1, round 2). Ollama
  // genuinely needs no credential, same as g4f-ollama/ovhcloud/kilo-gateway's
  // "optional" entries — but getProviderCategory() (providerRegistry.ts:304-308)
  // treats anything other than literal "apikey" as "oauth", which would silently
  // move every ollama-local connection from the apikey resilience bucket
  // (15 failures/30min window, 10min cooldown, breaker threshold 12 — the bucket
  // this connection has always lived in, since `!entry` also returns "apikey")
  // to the oauth bucket (10 failures/15min window, 5min cooldown, breaker
  // threshold 8), consumed by providerCooldownTracker.ts's whole-provider
  // circuit breaker, rateLimitManager.ts's apikey-only auto-enable gate,
  // errorClassifier.ts's 403/429 handling, and accountFallback.ts's
  // getProviderProfile(). That is exactly the resilience subsystem the bug
  // report's own symptom (connection going unhealthy after a 500) touches, and
  // is not something this fix's mandate (normalize outbound reasoning_effort)
  // asked to change. "apikey" preserves today's resilience bucket exactly
  // (byte-for-byte: `!entry` already resolves to "apikey" today) while still
  // registering the entry this fix needs. The only cost: getCredentialRequirement
  // ("ollama-local") stays "required" (today's answer, via providerCredentialRequirement.ts's
  // `if (!entry) return "required"` fallback) instead of flipping to "optional" —
  // deliberately deferred as a separate, out-of-scope cleanup (see design doc's
  // "Rejected side effect"), not bundled into a reasoning-effort fix.
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  // qwen3.5 / qwen3.8-family chat templates. Live-probed behavior (gremlin-4070ti
  // ollama, http://10.1.1.12:2701/v1, qwen3.8:27b-iq3-90k, 2026-10-03):
  //   reasoning_effort "low"    → HTTP 200
  //   reasoning_effort "medium" → HTTP 200
  //   reasoning_effort "high"   → HTTP 500  Jinja: "Unexpected reasoning effort high.
  //                               Supported types are xhigh (default), medium, and low."
  //   reasoning_effort "xhigh"  → HTTP 500  Jinja: "Unexpected reasoning effort MAX.
  //                               Supported types are xhigh (default), medium, and low."
  //   reasoning_effort OMITTED  → HTTP 200  (template applies its own xhigh default)
  // The template is SELF-INCONSISTENT: it names `xhigh` as its (default) top tier
  // but, when `xhigh` is sent explicitly, internally rewrites it to `max` and then
  // raises. The only explicit values that work are low/medium; the top tier is
  // reachable ONLY by omitting the field. So the declared ceiling is medium, with
  // `omitEffortAboveDeclaredCeiling` telling the forwarding clamp to DROP (not
  // clamp) any above-ceiling request (high/xhigh/max) so the backend defaults to
  // its own xhigh — which is the caller's intent (top reasoning tier).
  // Declared at the PROVIDER level because ollama-local is operator-hosted
  // passthrough: the concrete model id varies per deployment, but every
  // qwen3.5/qwen3.8 model sharing this template family behaves identically.
  // Per-model entries below opt out for models confirmed to use a different
  // template (qwen3, qwen3-vl, gemma4 — standard low/medium/high vocabulary).
  defaultSupportedThinkingEfforts: ["low", "medium"],
  omitEffortAboveDeclaredCeiling: true,
  models: [
    // Explicit opt-outs for model families on the SAME host confirmed NOT to
    // use the qwen3.5/qwen3.8 restricted template. Any other qwen3.5/qwen3.8-
    // family model served by any ollama-local connection falls through to
    // defaultSupportedThinkingEfforts above with no further per-model entries
    // required. Matched via reasoningEffort.ts's `:`-split family-prefix probe
    // (the observed tags are qwen3:14b-q4_K_M / qwen3-vl:8b-thinking-q4_K_M /
    // gemma4:e4b), so the ids here are the bare family segment before the ":".
    { id: "qwen3", name: "Qwen3", supportedThinkingEfforts: ["none", "low", "medium", "high"] },
    {
      // Family-prefix id must match the Ollama tag's segment BEFORE the first
      // ":" verbatim (the family probe splits on ":", it does not normalize
      // hyphens) — the observed tag is "qwen3-vl:8b-thinking-q4_K_M", so the id
      // here is "qwen3-vl", not "qwen3vl".
      id: "qwen3-vl",
      name: "Qwen3-VL",
      supportedThinkingEfforts: ["none", "low", "medium", "high"],
    },
    { id: "gemma4", name: "Gemma 4", supportedThinkingEfforts: ["none", "low", "medium", "high"] },
  ],
};
