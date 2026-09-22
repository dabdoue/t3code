import { describe, expect, it } from "@effect/vitest";

import {
  appendPiRpcChunk,
  assistantTextFromPiMessage,
  parsePiRpcLine,
  parsePiUsage,
  piModelRefFromSelection,
  piStopReasonToTurnState,
  piToolNameToItemType,
} from "./PiRpc.ts";

describe("appendPiRpcChunk", () => {
  it("splits complete lines and keeps the trailing partial in the buffer", () => {
    const first = appendPiRpcChunk("", '{"a":1}\n{"b"');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.buffer).toBe('{"b"');

    // The partial record completes in a later chunk — framing must not drop it.
    const second = appendPiRpcChunk(first.buffer, ':2}\n{"c":3}\n');
    expect(second.lines).toEqual(['{"b":2}', '{"c":3}']);
    expect(second.buffer).toBe("");
  });

  it("strips a trailing carriage return from CRLF producers", () => {
    expect(appendPiRpcChunk("", '{"a":1}\r\n{"b":2}\r\n').lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("does not split on U+2028/U+2029 inside JSON strings", () => {
    // Node's readline splits on these separators even though they are valid
    // inside a JSON string — the LF-only framing has to keep the record whole.
    const line = JSON.stringify({ message: "line1\u2028line2\u2029line3" });
    const parsed = appendPiRpcChunk("", `${line}\n`);
    expect(parsed.lines).toHaveLength(1);
    expect(JSON.parse(parsed.lines[0] ?? "{}")).toEqual({
      message: "line1\u2028line2\u2029line3",
    });
  });
});

describe("parsePiRpcLine", () => {
  it("parses a successful response with its correlation id and payload", () => {
    expect(
      parsePiRpcLine(
        JSON.stringify({ id: "cmd-1", type: "response", command: "get_state", success: true }),
      ),
    ).toEqual({
      kind: "response",
      id: "cmd-1",
      command: "get_state",
      success: true,
      data: undefined,
      error: undefined,
    });
  });

  it("keeps a response without an id addressable but unnamed", () => {
    const parsed = parsePiRpcLine(
      JSON.stringify({ type: "response", command: "prompt", success: false, error: "no model" }),
    );
    expect(parsed).toMatchObject({
      kind: "response",
      id: undefined,
      success: false,
      error: "no model",
    });
  });

  it("parses extension UI requests carrying an id", () => {
    const line = JSON.stringify({
      type: "extension_ui_request",
      id: "ui-7",
      method: "confirm",
      message: "Allow write?",
    });
    const parsed = parsePiRpcLine(line);
    expect(parsed).toMatchObject({ kind: "extension_ui_request", id: "ui-7", method: "confirm" });
  });

  it("drops extension UI requests without an id — they cannot be answered", () => {
    expect(
      parsePiRpcLine(JSON.stringify({ type: "extension_ui_request", method: "confirm" })),
    ).toBeUndefined();
  });

  it("skips extension UI responses and the JSON-mode session header", () => {
    expect(
      parsePiRpcLine(
        JSON.stringify({ type: "extension_ui_response", id: "ui-7", confirmed: true }),
      ),
    ).toBeUndefined();
    expect(
      parsePiRpcLine(JSON.stringify({ type: "session", version: 3, id: "session-1" })),
    ).toBeUndefined();
  });

  it("parses provider events and preserves the whole record", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    expect(parsePiRpcLine(line)).toEqual({
      kind: "event",
      type: "message_update",
      message: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      },
    });
  });

  it("reports records without a type as unparsed", () => {
    expect(parsePiRpcLine(JSON.stringify({ data: 42 }))).toEqual({
      kind: "unparsed",
      type: "",
      message: { data: 42 },
    });
  });

  it("returns undefined for blank, malformed, and non-object records", () => {
    expect(parsePiRpcLine("   ")).toBeUndefined();
    expect(parsePiRpcLine("{not json")).toBeUndefined();
    expect(parsePiRpcLine("42")).toBeUndefined();
    expect(parsePiRpcLine("[1,2]")).toBeUndefined();
  });
});

describe("parsePiUsage", () => {
  it("reads the full usage object", () => {
    expect(
      parsePiUsage({ input: 120, output: 30, cacheRead: 40, cacheWrite: 10, totalTokens: 200 }),
    ).toEqual({ input: 120, output: 30, cacheRead: 40, cacheWrite: 10, totalTokens: 200 });
  });

  it("defaults absent cache and total fields", () => {
    expect(parsePiUsage({ input: 120, output: 30 })).toEqual({
      input: 120,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
    });
  });

  it("rejects records without finite non-negative input and output counts", () => {
    expect(parsePiUsage(undefined)).toBeUndefined();
    expect(parsePiUsage("usage")).toBeUndefined();
    expect(parsePiUsage({ output: 30 })).toBeUndefined();
    expect(parsePiUsage({ input: "120", output: 30 })).toBeUndefined();
    expect(parsePiUsage({ input: -1, output: 30 })).toBeUndefined();
  });
});

describe("piStopReasonToTurnState", () => {
  it("maps aborted and error reasons onto the shared turn vocabulary", () => {
    expect(piStopReasonToTurnState("aborted")).toBe("interrupted");
    expect(piStopReasonToTurnState("error")).toBe("failed");
    for (const reason of ["stop", "length", "toolUse", undefined]) {
      expect(piStopReasonToTurnState(reason)).toBe("completed");
    }
  });
});

describe("piToolNameToItemType", () => {
  it("routes shell-like tools to command execution and file tools to file changes", () => {
    expect(piToolNameToItemType("bash")).toBe("command_execution");
    expect(piToolNameToItemType("Bash")).toBe("command_execution");
    expect(piToolNameToItemType("shell")).toBe("command_execution");
    expect(piToolNameToItemType("write")).toBe("file_change");
    expect(piToolNameToItemType("apply_patch")).toBe("file_change");
    expect(piToolNameToItemType("read")).toBe("dynamic_tool_call");
  });
});

describe("assistantTextFromPiMessage", () => {
  it("concatenates text blocks and skips thinking and tool calls", () => {
    expect(
      assistantTextFromPiMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Hello " },
          { type: "toolCall", id: "t1", name: "bash" },
          { type: "text", text: "world" },
        ],
      }),
    ).toBe("Hello world");
  });

  it("passes string content through and tolerates malformed messages", () => {
    expect(assistantTextFromPiMessage({ content: "plain" })).toBe("plain");
    expect(assistantTextFromPiMessage({ content: [{ type: "text" }] })).toBe("");
    expect(assistantTextFromPiMessage(undefined)).toBe("");
    expect(assistantTextFromPiMessage("assistant")).toBe("");
  });
});

describe("piModelRefFromSelection", () => {
  it("splits on the first slash so model ids may contain more", () => {
    expect(piModelRefFromSelection("vllm/qwen3")).toEqual({ provider: "vllm", modelId: "qwen3" });
    expect(piModelRefFromSelection("openai/gpt/mini")).toEqual({
      provider: "openai",
      modelId: "gpt/mini",
    });
  });

  it("rejects selections without a split on both sides of the slash", () => {
    expect(piModelRefFromSelection("qwen3")).toBeUndefined();
    expect(piModelRefFromSelection("/qwen3")).toBeUndefined();
    expect(piModelRefFromSelection("vllm/")).toBeUndefined();
  });
});
