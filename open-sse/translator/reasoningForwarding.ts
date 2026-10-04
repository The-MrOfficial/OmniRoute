import { FORMATS } from "./formats.ts";
import { hasThinkingConfig } from "../services/provider.ts";
import { getResolvedModelCapabilities, supportsReasoning } from "../services/modelCapabilities.ts";
import { requiresReasoningReplay } from "../services/reasoningCache.ts";
import {
  isPrefixCacheSensitive,
  resolveConnectionCacheOverride,
  type ConnectionCacheOverride,
} from "../utils/cacheControlPolicy.ts";

export type ReasoningForwardingDecision = {
  resolvedCapabilities: ReturnType<typeof getResolvedModelCapabilities>;
  replayRequirements: {
    provider: string;
    model: string;
    thinkingEnabled: boolean;
    supportsReasoning: boolean;
    interleavedField: string | null;
  };
  /** Target requires replayed reasoning_content (DeepSeek V4, Kimi K2, ...). */
  isReasoner: boolean;
  requiresExplicitReasoningReplay: boolean;
  /** Prefix-cache-sensitive upstream (llama-cpp): client reasoning_content is forwarded verbatim. */
  keepClientReasoning: boolean;
  /**
   * Whether historical assistant reasoning survives translation and reaches the
   * upstream prompt. Only an OpenAI-format, non-reasoner, non-prefix-cache target
   * has it stripped (translateRequest's OPENAI_INCOMPATIBLE_ECHO_FIELDS pass);
   * every other target format is treated as forwarding (conservative).
   */
  forwardsAssistantReasoning: boolean;
};

/**
 * Single source of truth for translateRequest's strip/forward decision on
 * historical assistant reasoning. The pre-flight context estimator uses the same
 * predicate (via willForwardAssistantReasoning) so the admission estimate counts
 * only reasoning the target will actually receive.
 */
export function resolveReasoningForwarding(params: {
  provider: unknown;
  model: unknown;
  targetFormat: unknown;
  body: Record<string, unknown> | null | undefined;
  connectionCacheOverride?: ConnectionCacheOverride | null;
}): ReasoningForwardingDecision {
  const normalizedProvider = String(params.provider ?? "");
  const normalizedModel = String(params.model ?? "");
  const keepClientReasoning = isPrefixCacheSensitive(
    typeof params.provider === "string" ? params.provider : null,
    params.connectionCacheOverride ?? null
  );
  const resolvedCapabilities = getResolvedModelCapabilities({
    provider: normalizedProvider,
    model: normalizedModel,
  });
  const replayRequirements = {
    provider: normalizedProvider,
    model: normalizedModel,
    thinkingEnabled: params.body ? hasThinkingConfig(params.body) : false,
    supportsReasoning: supportsReasoning({
      provider: normalizedProvider,
      model: normalizedModel,
    }),
    interleavedField: resolvedCapabilities?.interleavedField ?? null,
  };
  const isReasoner = requiresReasoningReplay(replayRequirements);
  const requiresExplicitReasoningReplay = requiresReasoningReplay({
    ...replayRequirements,
    allowLegacyFallback: false,
  });
  const forwardsAssistantReasoning =
    isReasoner || keepClientReasoning || params.targetFormat !== FORMATS.OPENAI;
  return {
    resolvedCapabilities,
    replayRequirements,
    isReasoner,
    requiresExplicitReasoningReplay,
    keepClientReasoning,
    forwardsAssistantReasoning,
  };
}

/** True when the target will receive (and render) historical assistant reasoning. */
export function willForwardAssistantReasoning(params: {
  provider: unknown;
  model: unknown;
  targetFormat: unknown;
  body: Record<string, unknown> | null | undefined;
  credentials?: { providerSpecificData?: unknown } | null;
}): boolean {
  return resolveReasoningForwarding({
    provider: params.provider,
    model: params.model,
    targetFormat: params.targetFormat,
    body: params.body,
    connectionCacheOverride: resolveConnectionCacheOverride(
      params.credentials?.providerSpecificData
    ),
  }).forwardsAssistantReasoning;
}
