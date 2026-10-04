import { describe, test, expect } from "vitest";
import {
  injectMemory,
  shouldInjectMemory,
  formatMemoryContext,
  providerSupportsSystemMessage,
  ChatRequest,
  ChatMessage,
} from "../injection";
import { Memory, MemoryType } from "../types";

function makeMemory(content: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    apiKeyId: "key-1",
    sessionId: "sess-1",
    type: MemoryType.FACTUAL,
    key: "test-key",
    content,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: null,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

describe("formatMemoryContext", () => {
  test("returns empty string for empty array", () => {
    expect(formatMemoryContext([])).toBe("");
  });

  test("single memory is formatted with 'Memory context:' prefix", () => {
    const result = formatMemoryContext([makeMemory("User prefers dark mode")]);
    expect(result).toBe("Memory context: User prefers dark mode");
  });

  test("multiple memories are joined with newline", () => {
    const memories = [makeMemory("fact one"), makeMemory("fact two")];
    const result = formatMemoryContext(memories);
    expect(result).toBe("Memory context: fact one\nfact two");
  });

  test("trims whitespace from individual memory content", () => {
    const result = formatMemoryContext([makeMemory("  padded content  ")]);
    expect(result).toBe("Memory context: padded content");
  });

  test("filters out blank memories", () => {
    const memories = [makeMemory("real content"), makeMemory("   ")];
    const result = formatMemoryContext(memories);
    expect(result).toBe("Memory context: real content");
  });
});

describe("providerSupportsSystemMessage", () => {
  test("returns true for null/undefined provider", () => {
    expect(providerSupportsSystemMessage(null)).toBe(true);
    expect(providerSupportsSystemMessage(undefined)).toBe(true);
  });

  test("returns true for standard providers", () => {
    expect(providerSupportsSystemMessage("openai")).toBe(true);
    expect(providerSupportsSystemMessage("anthropic")).toBe(true);
    expect(providerSupportsSystemMessage("deepseek")).toBe(true);
    expect(providerSupportsSystemMessage("google")).toBe(true);
  });

  test("returns false for o1 family providers", () => {
    expect(providerSupportsSystemMessage("o1")).toBe(false);
    expect(providerSupportsSystemMessage("o1-mini")).toBe(false);
    expect(providerSupportsSystemMessage("o1-preview")).toBe(false);
  });

  test("comparison is case-insensitive", () => {
    expect(providerSupportsSystemMessage("O1")).toBe(false);
    expect(providerSupportsSystemMessage("O1-MINI")).toBe(false);
  });
});

describe("injectMemory — system message injection", () => {
  test("injects memory as system message when provider supports it", () => {
    const request = makeRequest();
    const memories = [makeMemory("User prefers concise answers")];
    const result = injectMemory(request, memories, "openai");

    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("Memory context: User prefers concise answers");
    expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  test("preserves existing messages after injected system message", () => {
    const request = makeRequest({
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
    });
    const memories = [makeMemory("User is an expert developer")];
    const result = injectMemory(request, memories, "anthropic");

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("Memory context:");
    expect(result.messages[1]).toEqual({ role: "system", content: "You are helpful" });
    expect(result.messages[2]).toEqual({ role: "user", content: "Hello" });
  });

  test("does not mutate the original request", () => {
    const request = makeRequest();
    const originalMessages = [...request.messages];
    const memories = [makeMemory("Some fact")];
    injectMemory(request, memories, "openai");

    expect(request.messages).toEqual(originalMessages);
  });

  test("preserves all other request fields", () => {
    const request = makeRequest({ temperature: 0.7, max_tokens: 256, stream: true });
    const memories = [makeMemory("fact")];
    const result = injectMemory(request, memories, "openai");

    expect(result.temperature).toBe(0.7);
    expect(result.max_tokens).toBe(256);
    expect(result.stream).toBe(true);
    expect(result.model).toBe("gpt-4");
  });
});

describe("injectMemory — message prefix fallback", () => {
  test("injects memory as first user message for o1 provider", () => {
    const request = makeRequest();
    const memories = [makeMemory("User context detail")];
    const result = injectMemory(request, memories, "o1");

    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Memory context: User context detail");
    expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  test("injects memory as first user message for o1-mini", () => {
    const request = makeRequest();
    const memories = [makeMemory("Preference")];
    const result = injectMemory(request, memories, "o1-mini");

    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("Memory context:");
  });
});

describe("injectMemory — edge cases", () => {
  test("returns original request when memories array is empty", () => {
    const request = makeRequest();
    const result = injectMemory(request, [], "openai");
    expect(result).toBe(request);
  });

  test("returns original request when memories is null-ish", () => {
    const request = makeRequest();
    const result = injectMemory(request, null as unknown as Memory[], "openai");
    expect(result).toBe(request);
  });

  test("handles request with empty messages array", () => {
    const request = makeRequest({ messages: [] });
    const memories = [makeMemory("fact")];
    const result = injectMemory(request, memories, "openai");

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("system");
  });

  test("handles multiple memories combined into single injection", () => {
    const request = makeRequest();
    const memories = [makeMemory("fact A"), makeMemory("fact B"), makeMemory("fact C")];
    const result = injectMemory(request, memories, "openai");

    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("Memory context: fact A\nfact B\nfact C");
    expect(result.messages).toHaveLength(2);
  });
});

describe("injectMemory — Claude-family cache-safe splice gate (#11290)", () => {
  test("does not splice mid-array on anthropic when the last turn before the splice point is plain assistant text", () => {
    const request = makeRequest({
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: "turn 1 question" },
        { role: "assistant", content: "turn 1 answer" },
        { role: "user", content: "turn 2 question" },
      ],
    });
    const memories = [makeMemory("dark mode")];

    const result = injectMemory(request, memories, "anthropic", { cacheSafe: true });

    // The plain-text assistant turn must stay immediately followed by the final user
    // turn — no system message spliced between them (that shape is what Opus 5 rejects
    // with HTTP 400, #11290). Memory is merged into the leading system message instead.
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("Memory context: dark mode");
    expect(result.messages[0].content).toContain("SYSTEM PROMPT");
    expect(result.messages[2]).toEqual({ role: "assistant", content: "turn 1 answer" });
    expect(result.messages[3]).toEqual({ role: "user", content: "turn 2 question" });
  });
});

describe("injectMemory — self-hosted strict system-first providers (Failure C)", () => {
  const STRICT_PROVIDERS = ["vllm", "ollama-local", "ollama", "llama-cpp", "llamacpp"];

  for (const provider of STRICT_PROVIDERS) {
    test(`${provider}: cache-safe injection merges memory into the leading system message (index 0)`, () => {
      const request = makeRequest({
        messages: [
          { role: "system", content: "SELF-HOSTED SYSTEM PROMPT" },
          { role: "user", content: "turn 1 question" },
          { role: "assistant", content: "turn 1 answer" },
          { role: "user", content: "turn 2 question" },
        ],
      });
      const memories = [makeMemory("User prefers concise answers")];

      const result = injectMemory(request, memories, provider, { cacheSafe: true });

      // Memory must be merged INTO messages[0], starting with the memory text.
      expect(result.messages[0].role).toBe("system");
      // This case uses string content; narrow explicitly since ChatMessage.content
      // is now `string | ContentBlock[]` after the array-shape widening.
      expect(typeof result.messages[0].content).toBe("string");
      const mergedContent = result.messages[0].content as string;
      expect(mergedContent.startsWith("Memory context: User prefers concise answers")).toBe(true);
      expect(mergedContent).toContain("SELF-HOSTED SYSTEM PROMPT");

      // No system-role message may exist at any index > 0 (strict templates 400/500 on it).
      const laterSystem = result.messages.slice(1).filter((m) => m.role === "system");
      expect(laterSystem).toHaveLength(0);

      // Original turns preserved contiguously after the merged system message.
      expect(result.messages).toHaveLength(4);
      expect(result.messages[1]).toEqual({ role: "user", content: "turn 1 question" });
      expect(result.messages[2]).toEqual({ role: "assistant", content: "turn 1 answer" });
      expect(result.messages[3]).toEqual({ role: "user", content: "turn 2 question" });
    });
  }

  // Regression for the orchestrator-prompt-destruction bug: the Roo/Zoo OpenAI-format
  // client sends messages[0].content as an ARRAY of content blocks. Blindly interpolating
  // it collapsed a 54K system prompt to "[object Object]" (findings §Q5). The merge must
  // be shape-aware: prepend memory as a leading text block, preserving the original blocks.
  for (const provider of STRICT_PROVIDERS) {
    test(`${provider}: array-shaped system content merges memory as a leading text block without "[object Object]"`, () => {
      const request = makeRequest({
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "You are Zoo, the orchestrator." },
              { type: "text", text: "start them together" },
            ],
          },
          { role: "user", content: "dispatch the tasks" },
        ],
      });
      const memories = [makeMemory("User prefers concise answers")];

      const result = injectMemory(request, memories, provider);

      const first = result.messages[0];
      expect(first.role).toBe("system");
      // Content must remain an array of blocks (not coerced to a string).
      expect(Array.isArray(first.content)).toBe(true);
      const blocks = first.content as Array<{ type: string; text?: string }>;

      // (b) memory is merged into the leading text block; no block is added, because
      // Ollama expands each system block into its own system message.
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({
        type: "text",
        text: "Memory context: User prefers concise answers\nYou are Zoo, the orchestrator.",
      });

      // (a) the original block text survives in order.
      const allText = blocks.map((b) => b.text ?? "").join("\n");
      expect(allText).toContain("You are Zoo, the orchestrator.");
      expect(allText).toContain("start them together");

      // (c) nowhere in the merged content is the "[object Object]" coercion signature.
      expect(allText).not.toContain("[object Object]");
      expect(JSON.stringify(result.messages)).not.toContain("[object Object]");

      // Strict templates still forbid a system message at any later index.
      const laterSystem = result.messages.slice(1).filter((m) => m.role === "system");
      expect(laterSystem).toHaveLength(0);
    });
  }

  test("ollama: single-block system content stays a single block after memory merge", () => {
    const request = makeRequest({
      messages: [
        { role: "system", content: [{ type: "text", text: "You are a reader." }] },
        { role: "user", content: "read the spec" },
      ],
    });
    const result = injectMemory(request, [makeMemory("spec lives in specs/")], "ollama-local");
    const blocks = result.messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks).toEqual([
      { type: "text", text: "Memory context: spec lives in specs/\nYou are a reader." },
    ]);
  });

  test("array system content with a non-text lead block gets a new leading memory block", () => {
    const request = makeRequest({
      messages: [
        {
          role: "system",
          content: [
            { type: "image_url", image_url: { url: "data:," } },
            { type: "text", text: "Describe it." },
          ] as unknown as ChatMessage["content"],
        },
        { role: "user", content: "go" },
      ],
    });
    const result = injectMemory(request, [makeMemory("m")], "vllm");
    const blocks = result.messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks[0]).toEqual({ type: "text", text: "Memory context: m" });
    expect(blocks).toHaveLength(3);
  });

  test("regression guard: non-strict provider keeps the #3890 cache-safe mid-array splice", () => {
    const request = makeRequest({
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: "turn 1 question" },
        { role: "assistant", content: "turn 1 answer" },
        { role: "user", content: "turn 2 question" },
      ],
    });
    const memories = [makeMemory("User prefers concise answers")];

    const result = injectMemory(request, memories, "openai", { cacheSafe: true });

    // The memory system message is spliced just before the LAST user turn (mid-array),
    // leaving the original leading system message untouched at index 0.
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" });
    expect(result.messages[3].role).toBe("system");
    expect(result.messages[3].content).toBe("Memory context: User prefers concise answers");
    expect(result.messages[4]).toEqual({ role: "user", content: "turn 2 question" });
  });
});

describe("shouldInjectMemory", () => {
  test("returns true when messages are present and enabled not set", () => {
    const request = makeRequest();
    expect(shouldInjectMemory(request)).toBe(true);
  });

  test("returns false when config.enabled is false", () => {
    const request = makeRequest();
    expect(shouldInjectMemory(request, { enabled: false })).toBe(false);
  });

  test("returns false when messages array is empty", () => {
    const request = makeRequest({ messages: [] });
    expect(shouldInjectMemory(request)).toBe(false);
  });
});
