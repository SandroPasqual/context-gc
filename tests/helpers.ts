/**
 * Test helpers — builders that mirror the real message shapes the extension
 * expects (see src/context-gc.ts getMessageText). Kept dependency-free so they
 * can be imported by any Node test-runner.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type AnyMessage = {
  role: string;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  command?: unknown;
  output?: unknown;
  [key: string]: unknown;
};

export function userMsg(text: string): AnyMessage {
  return { role: "user", content: text };
}

export function toolCallBlock(id: string, name: string, args: Record<string, unknown>): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

export function assistantTool(id: string, name: string, args: Record<string, unknown>): AnyMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }, toolCallBlock(id, name, args)],
  };
}

export function toolResult(id: string, name: string, text: string): AnyMessage {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] };
}

/** A single bashExecution message. */
export function bashExecution(command: string, output: string): AnyMessage {
  return { role: "bashExecution", command, output };
}

/**
 * Build a coherent assistant-tool + toolResult pair so the toolResult has a
 * verifiable identity (required for dedup). `n` pairs, each with a unique id.
 */
export function toolPairs(name: string, n: number, prefix = "p", text = "ok"): AnyMessage[] {
  const out: AnyMessage[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    out.push(assistantTool(id, name, name === "read" ? { path: `/${id}.txt` } : name === "bash" ? { command: id } : {}));
    out.push(toolResult(id, name, text));
  }
  return out;
}

/** A very long toolResult body: `n` lines of "line-<i>-payload". */
export function longText(n: number): string {
  return Array.from({ length: n }, (_, i) => `line-${i}-payload`).join("\n");
}

/** Cast a loose test message to the runtime AgentMessage type. */
export const asMsg = (m: AnyMessage): AgentMessage =>
  m as unknown as AgentMessage;
/** Cast a loose message list to the runtime AgentMessage[] type. */
export const asMsgs = (ms: AnyMessage[]): AgentMessage[] =>
  ms as unknown as AgentMessage[];

/** Turn a flat toolResult list into a single concatenated string. */
export function bodyOf(m: AnyMessage): string {
  const c = m.content as Array<{ type?: unknown; text?: unknown }>;
  if (!Array.isArray(c)) return "";
  return c
    .map((b) => (b && typeof b === "object" && b.type === "text" ? String(b.text ?? "") : ""))
    .join("");
}
