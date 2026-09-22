/**
 * PiRpc — protocol layer for `pi --mode rpc`.
 *
 * pi speaks newline-delimited JSON over stdin/stdout with strict LF framing:
 * records split on `\n` only, an optional trailing `\r` is stripped, and
 * generic line readers (Node `readline`) are not protocol-compliant because
 * they also split on U+2028/U+2029 — both valid inside JSON strings. The
 * framing helpers here are the only place that touches raw buffer text.
 *
 * Wire shapes (docs from the pi distribution):
 *   - commands in:  {"id": "...", "type": "prompt", "message": "..."}
 *   - responses out: {"id": "...", "type": "response", "command": "...",
 *                     "success": true, "data": ...} / {"success": false, "error": "..."}
 *   - events out:    {"type": "agent_start" | "message_update" | ...}
 *   - extension UI:  {"type": "extension_ui_request", "id": "...", "method":
 *                     "select"|"confirm"|"input"|"editor"|..., ...} answered
 *                     by {"type": "extension_ui_response", "id": "...", ...}
 *
 * The module stays parse-only: the adapter owns the child process, the
 * pending-request Deferred map, and runtime-event emission.
 *
 * @module provider/pi/PiRpc
 */
export type PiRpcCommand = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PiRpcResponse {
  readonly kind: "response";
  readonly id: string | undefined;
  readonly command: string;
  readonly success: boolean;
  readonly data: unknown;
  readonly error: string | undefined;
}

export interface PiRpcExtensionUiRequest {
  readonly kind: "extension_ui_request";
  readonly id: string;
  readonly method: string;
  readonly message: Record<string, unknown>;
}

export interface PiRpcEvent {
  readonly kind: "event";
  readonly type: string;
  readonly message: Record<string, unknown>;
}

export type PiRpcInbound =
  | PiRpcResponse
  | PiRpcExtensionUiRequest
  | PiRpcEvent
  | { readonly kind: "unparsed"; readonly message: Record<string, unknown> };

/**
 * Split one stdout chunk into complete LF-delimited lines plus the remaining
 * buffer. `\r` is stripped so CRLF producers still parse.
 */
export const appendPiRpcChunk = (
  buffer: string,
  chunk: string,
): { readonly lines: ReadonlyArray<string>; readonly buffer: string } => {
  const combined = `${buffer}${chunk}`;
  const lines: string[] = [];
  let start = 0;
  while (true) {
    const newlineIndex = combined.indexOf("\n", start);
    if (newlineIndex === -1) break;
    let line = combined.slice(start, newlineIndex);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    lines.push(line);
    start = newlineIndex + 1;
  }
  return { lines, buffer: combined.slice(start) };
};

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

/** Parse one LF-delimited record into a discriminated inbound message. */
export const parsePiRpcLine = (line: string): PiRpcInbound | undefined => {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const type = readString(parsed, "type") ?? "";
  if (type === "response") {
    return {
      kind: "response",
      id: readString(parsed, "id"),
      command: readString(parsed, "command") ?? "",
      success: parsed.success === true,
      data: parsed.data,
      error: readString(parsed, "error"),
    };
  }
  if (type === "extension_ui_request") {
    const id = readString(parsed, "id");
    if (id === undefined) return undefined;
    return {
      kind: "extension_ui_request",
      id,
      method: readString(parsed, "method") ?? "",
      message: parsed,
    };
  }
  if (type === "extension_ui_response" || type === "session") {
    // Responses never travel upstream, and the JSON-mode session header line
    // is not part of the RPC stream — skip both rather than guessing.
    return undefined;
  }
  return { kind: type ? "event" : "unparsed", type, message: parsed };
};

/** The assistant-message usage object pi reports on message_end / message_update. */
export interface PiUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

/** Read a pi usage object, tolerating missing or non-numeric fields. */
export const parsePiUsage = (value: unknown): PiUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const readCount = (key: string): number | undefined => {
    const raw = value[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  };
  const input = readCount("input");
  const output = readCount("output");
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cacheRead: readCount("cacheRead") ?? 0,
    cacheWrite: readCount("cacheWrite") ?? 0,
    totalTokens: readCount("totalTokens") ?? input + output,
  };
};

/** pi assistant stop reasons → the shared turn vocabulary. */
export const piStopReasonToTurnState = (
  stopReason: string | undefined,
): "completed" | "failed" | "interrupted" => {
  if (stopReason === "aborted") return "interrupted";
  if (stopReason === "error") return "failed";
  return "completed";
};

/** pi tool names → the canonical tool-lifecycle item vocabulary. */
export const piToolNameToItemType = (toolName: string): string => {
  const normalized = toolName.toLowerCase();
  if (["bash", "shell", "command", "terminal"].includes(normalized)) {
    return "command_execution";
  }
  if (
    ["write", "edit", "apply_patch", "patch", "multiedit", "notebook_edit"].includes(normalized)
  ) {
    return "file_change";
  }
  return "dynamic_tool_call";
};

/**
 * Concatenate the text blocks of a pi message into reply text. Thinking and
 * toolCall blocks stay out — they are narration and calls, not the reply.
 */
export const assistantTextFromPiMessage = (message: unknown): string => {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
};

/** Split a `provider/model` selection into pi's `set_model` fields. */
export const piModelRefFromSelection = (
  model: string,
): { readonly provider: string; readonly modelId: string } | undefined => {
  const separatorIndex = model.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === model.length - 1) return undefined;
  return {
    provider: model.slice(0, separatorIndex),
    modelId: model.slice(separatorIndex + 1),
  };
};
