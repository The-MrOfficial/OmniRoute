/**
 * Deterministic, synthetic reproduction of a real Zoo Code agent request
 * (hybrid/code, 2026-10-03T12:44:10Z call log, provider usage tokens.in 52489).
 *
 * Only the SHAPE and per-component JSON char lengths are reproduced — every
 * string is synthetic filler (no user content). Measured on the real body:
 *   113 messages (1 system + 112), 22 tools, 26 assistant turns with reasoning.
 *   JSON chars: messages 455,359 total; assistant reasoning_content 289,377;
 *   system 54,255; tool results 57,634; user 18,989; tool_calls 16,640;
 *   tool schemas 39,640.
 *
 * Ground truth from the RTX 5090's own tokenizer (vLLM POST /tokenize on
 * esnixi 127.0.0.1:8010, qwen3.8-27b-nvfp4 chat template, add_generation_prompt,
 * mid-conversation memory system message merged into system[0]), 2026-10-03:
 *   full body as sent (reasoning_content present, stripped by the template path): 53,976
 *   same, reasoning_content removed:                                              53,976
 *   same, no tools:                                                               44,497
 *   all reasoning renamed to `reasoning` (rendered by the template):              154,252
 */

export const REAL_TOKENS_FULL = 53_976;
export const REAL_TOKENS_NO_TOOLS = 44_497;
export const REAL_TOKENS_REASONING_RENDERED = 154_252;

export const ZOO_COMPONENT_CHARS = {
  messages: 455_359,
  reasoning: 289_377,
  system: 54_255,
  toolResults: 57_634,
  user: 18_989,
  toolCalls: 16_640,
  tools: 39_640,
} as const;

const WORDS = [
  "the",
  "build",
  "module",
  "returns",
  "config",
  "handler",
  "request",
  "value",
  "should",
  "check",
  "error",
  "path",
  "token",
  "result",
  "update",
  "function",
  "because",
  "import",
  "test",
  "state",
  "context",
  "before",
  "after",
  "router",
  "target",
];

const CODE = [
  "const",
  "value",
  "=",
  "await",
  "load(path);",
  "if",
  "(!result)",
  "return",
  "null;",
  "export",
  "function",
  "resolve(input)",
  "{",
  "}",
  "items.map((x)",
  "=>",
  "x.id);",
  "// note:",
  "throw",
  "new Error(msg);",
];

/** Deterministic filler of exactly `length` chars (no characters JSON must escape). */
function filler(length: number, seed: number, vocabulary: readonly string[] = WORDS): string {
  if (length <= 0) return "";
  let state = (seed * 2654435761) >>> 0 || 1;
  const parts: string[] = [];
  let size = 0;
  while (size < length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const word = vocabulary[state % vocabulary.length];
    parts.push(word);
    size += word.length + 1;
  }
  return parts.join(" ").slice(0, length);
}

type Message = Record<string, unknown>;

/**
 * Build the Zoo-like body. `scale` multiplies every content length (1 ≈ the
 * real 53,976-token request); message/tool counts stay fixed.
 */
export function buildZooLikeBody(options: { scale?: number; includeTools?: boolean } = {}) {
  const scale = options.scale ?? 1;
  const includeTools = options.includeTools ?? true;
  const len = (n: number) => Math.max(1, Math.round(n * scale));

  const USERS = 20;
  const ASSISTANTS = 46;
  const REASONING_TURNS = 26;
  const TOOL_SCHEMAS = 22;

  const messages: Message[] = [
    { role: "system", content: filler(len(ZOO_COMPONENT_CHARS.system - 30), 1) },
  ];
  const userContent = len(ZOO_COMPONENT_CHARS.user / USERS - 28);
  const toolContent = len(ZOO_COMPONENT_CHARS.toolResults / ASSISTANTS - 60);
  const reasoningPerTurn = len(ZOO_COMPONENT_CHARS.reasoning / REASONING_TURNS);
  // Envelope + visible assistant text: the remainder of the measured message chars.
  const assistantText = len(
    (ZOO_COMPONENT_CHARS.messages -
      ZOO_COMPONENT_CHARS.reasoning -
      ZOO_COMPONENT_CHARS.system -
      ZOO_COMPONENT_CHARS.toolResults -
      ZOO_COMPONENT_CHARS.user -
      ZOO_COMPONENT_CHARS.toolCalls) /
      ASSISTANTS -
      60
  );
  const argumentText = len(ZOO_COMPONENT_CHARS.toolCalls / ASSISTANTS - 103);

  messages.push({ role: "user", content: filler(userContent, 2) });
  let usersPlaced = 1;
  for (let turn = 0; turn < ASSISTANTS; turn++) {
    const callId = `call_${String(turn).padStart(8, "0")}`;
    const assistant: Message = {
      role: "assistant",
      content: filler(assistantText, 100 + turn),
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: `tool_${turn % TOOL_SCHEMAS}`,
            arguments: JSON.stringify({ path: filler(argumentText, 300 + turn) }),
          },
        },
      ],
    };
    // Spread the 26 reasoning-bearing turns across the 46 assistant turns.
    if (
      Math.floor(((turn + 1) * REASONING_TURNS) / ASSISTANTS) >
      Math.floor((turn * REASONING_TURNS) / ASSISTANTS)
    ) {
      assistant.reasoning_content = filler(reasoningPerTurn, 500 + turn);
    }
    messages.push(assistant);
    messages.push({
      role: "tool",
      tool_call_id: callId,
      content: filler(toolContent, 700 + turn, CODE),
    });
    // Spread the remaining 19 user turns across the conversation.
    const wantUsers = 1 + Math.floor(((turn + 1) * (USERS - 1)) / ASSISTANTS);
    if (wantUsers > usersPlaced && usersPlaced < USERS) {
      messages.push({ role: "user", content: filler(userContent, 900 + turn) });
      usersPlaced += 1;
    }
  }

  const body: Record<string, unknown> = { model: "qwen3.8-27b-nvfp4", stream: true, messages };
  if (includeTools) {
    const descriptionText = len(ZOO_COMPONENT_CHARS.tools / TOOL_SCHEMAS - 316);
    body.tools = Array.from({ length: TOOL_SCHEMAS }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: filler(descriptionText, 1100 + index),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the workspace root" },
            line_range: { type: "string", description: "Optional inclusive line range" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    }));
  }
  return body;
}

/** Measured JSON char lengths per component, for the fixture self-check. */
export function measureZooLikeBody(body: Record<string, unknown>) {
  const messages = body.messages as Message[];
  let reasoning = 0;
  for (const message of messages) {
    if (typeof message.reasoning_content === "string")
      reasoning += message.reasoning_content.length;
  }
  return {
    messageCount: messages.length,
    assistantReasoningTurns: messages.filter((m) => typeof m.reasoning_content === "string").length,
    messages: JSON.stringify(messages).length,
    reasoning,
    tools: body.tools ? JSON.stringify(body.tools).length : 0,
  };
}
