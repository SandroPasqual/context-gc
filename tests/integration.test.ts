import { test } from "node:test";
import assert from "node:assert/strict";

// Silence logging so tests never touch the real ~/.pi/agent/logs.
process.env.CONTEXT_GC_NO_LOG = "1";

import ext from "../src/context-gc.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AnyMessage, toolPairs } from "./helpers.ts";

interface FakeCtx {
  contextUsage?: { percent: number; maxTokens?: number };
  status: string | null;
  sessionId: string;
}

function makeFakePi() {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const pi = {
    on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers[event] = handler;
    },
    ui: {
      setStatus: (_key: string, value: string) => {
        (pi as unknown as { lastStatus: string }).lastStatus = value;
      },
    },
  } as unknown as {
    on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => void;
    ui: { setStatus: (key: string, value: string) => void };
    lastStatus?: string;
  };
  return { pi, handlers };
}

test("context-gc: default export is a function installing 3+ hooks", () => {
  assert.equal(typeof ext, "function");
  const { pi, handlers } = makeFakePi();
  ext(pi as unknown as ExtensionAPI);
  assert.ok(typeof handlers.context === "function");
  assert.ok(typeof handlers.session_start === "function");
  assert.ok(typeof handlers.agent_settled === "function");
});

test("context-gc: tier-2 large build collapses without removing or quarantining", async () => {
  const { pi, handlers } = makeFakePi();
  ext(pi as unknown as ExtensionAPI);

  const body = Array.from({ length: 4000 }, (_, i) => `line-${i}-payload`).join("\n");
  // Filler so the build toolResult lands outside the protected recent window.
  const messages: AnyMessage[] = [
    { role: "user", content: "go" },
    ...toolPairs("read", 6, "fa"),
    { role: "assistant", content: [{ type: "text", text: "" }, { type: "toolCall", id: "b", name: "build", arguments: {} }] },
    { role: "toolResult", toolCallId: "b", toolName: "build", content: [{ type: "text", text: body }] },
    ...toolPairs("read", 6, "fb"),
  ];

  const ctx: FakeCtx = {
    contextUsage: { percent: 60, maxTokens: 0 },
    status: null,
    sessionId: "s1",
  };

  await (handlers.agent_start as Function)({}, { ui: { setStatus: pi.ui.setStatus } });
  const ret = await (handlers.context as Function)(
    { messages: messages as never },
    { getContextUsage: () => ctx.contextUsage, ui: { setStatus: pi.ui.setStatus }, sessionManager: { getSessionId: () => ctx.sessionId } } as never,
  );

  const out = ret as { messages: AnyMessage[] };
  assert.equal(out.messages.length, messages.length, "nothing removed");
  // The build toolResult (collapsed) must be present; the user message intact.
  const build = out.messages.find((m) => m.toolName === "build");
  assert.ok(build, "build result still present");
  assert.ok(String((build.content as Array<{ text: string }>)[0].text).includes("Tool Output Collapsed"), "build collapsed");
  assert.ok(pi.lastStatus?.includes("context-gc"), "status updated");
});

test("context-gc: mid-run calls (no new agent_start) do not process", async () => {
  const { pi, handlers } = makeFakePi();
  ext(pi as unknown as ExtensionAPI);

  const body = Array.from({ length: 4000 }, (_, i) => `l${i}`).join("\n");
  const messages: AnyMessage[] = [
    { role: "user", content: "go" },
    ...toolPairs("read", 6, "fa"),
    { role: "assistant", content: [{ type: "text", text: "" }, { type: "toolCall", id: "b", name: "build", arguments: {} }] },
    { role: "toolResult", toolCallId: "b", toolName: "build", content: [{ type: "text", text: body }] },
    ...toolPairs("read", 6, "fb"),
  ];

  const ctx = { getContextUsage: () => ({ percent: 60 }), ui: {}, sessionManager: { getSessionId: () => "s" } };

  // First (fresh) call — should process.
  await (handlers.agent_start as Function)();
  const first = await (handlers.context as Function)({ messages: messages as never }, ctx as never);
  assert.ok(first && "messages" in (first as object), "first call processes");

  // Second call without a new agent_start — must be left alone (undefined).
  const second = await (handlers.context as Function)({ messages: messages as never }, ctx as never);
  assert.equal(second, undefined, "mid-run call is untouched");
});
