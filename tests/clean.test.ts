import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanMessages } from "../src/context-gc.ts";
import {
  userMsg,
  assistantTool,
  toolResult,
  bashExecution,
  toolPairs,
  bodyOf,
  asMsgs,
  AnyMessage,
} from "./helpers.ts";

/** Extra filler so target messages fall outside the protected recent window.
 *  Each call must use a unique prefix — identical (id,path,text) pairs would
 *  themselves dedup and mask the result under test. */
function pad(prefix: string, n: number): AnyMessage[] {
  return toolPairs("read", n, prefix);
}

test("cleanMessages: exact toolResult duplicate is deduped (tier 1)", () => {
  const msgs: AnyMessage[] = [
    userMsg("go"),
    ...pad("fa", 4),
    assistantTool("r0", "read", { path: "/a.txt" }),
    toolResult("r0", "read", "SAME"),
    assistantTool("r1", "read", { path: "/a.txt" }),
    toolResult("r1", "read", "SAME"),
    ...pad("fb", 4),
  ];
  const res = cleanMessages(asMsgs(msgs), 1);
  assert.equal(res.removed, 1, "one duplicate removed");
  assert.equal(res.diag.dupHits, 1);
  assert.ok(res.estimatedTokensSaved > 0);
  assert.ok(res.quarantined[0].reason === "dup");
});

test("cleanMessages: narrative messages are never removed", () => {
  const msgs: AnyMessage[] = [
    userMsg("hello there"),
    assistantTool("r0", "read", { path: "/a.txt" }),
    toolResult("r0", "read", "X"),
  ];
  const res = cleanMessages(asMsgs(msgs), 3);
  assert.equal(res.removed, 0);
  assert.equal(res.messages.length, 3);
  assert.equal(res.messages[0].role, "user");
  assert.equal(res.messages[1].role, "assistant");
});

test("cleanMessages: protected recent turns are never removed", () => {
  // Only a duplicate inside the last 6 positions must survive.
  const msgs: AnyMessage[] = [
    userMsg("go"),
    ...pad("f6", 6),
    assistantTool("r0", "read", { path: "/a.txt" }),
    toolResult("r0", "read", "X"),
    assistantTool("r1", "read", { path: "/a.txt" }),
    toolResult("r1", "read", "X"),
  ];
  const res = cleanMessages(asMsgs(msgs), 3);
  assert.equal(res.removed, 0, "duplicates in protected window survive");
});

test("cleanMessages: older read of a mutated file is invalidated (tier 2)", () => {
  const msgs: AnyMessage[] = [
    userMsg("go"),
    ...pad("fa", 6),
    assistantTool("e0", "edit", { path: "/a.txt", oldText: "o", newText: "n" }),
    assistantTool("r0", "read", { path: "/a.txt" }),
    toolResult("r0", "read", "FIRST"),
    assistantTool("r1", "read", { path: "/a.txt" }),
    toolResult("r1", "read", "SECOND"),
    ...pad("fb", 6),
  ];
  const res = cleanMessages(asMsgs(msgs), 2);
  assert.equal(res.diag.readInvalidated, 1, "one stale read invalidated");
  assert.equal(res.removed, 1);
  // The latest read (SECOND) survives.
  const kept = res.messages
    .filter(
      (m) =>
        m.role === "toolResult" &&
        "toolName" in m &&
        (m as { toolName: string }).toolName === "read",
    )
    .map((m) => m as unknown as AnyMessage);
  assert.ok(kept.some((m) => bodyOf(m) === "SECOND"));
  assert.ok(!kept.some((m) => bodyOf(m) === "FIRST"));
});

test("cleanMessages: identical short bash outputs are deduped (tier 1)", () => {
  const msgs: AnyMessage[] = [
    userMsg("go"),
    ...pad("fa", 4),
    bashExecution("pwd", "/home/user"),
    bashExecution("pwd", "/home/user"),
    ...pad("fb", 4),
  ];
  const res = cleanMessages(asMsgs(msgs), 1);
  assert.equal(res.diag.bashDeduped, 1);
  assert.equal(res.removed, 1);
});

test("cleanMessages: large toolResult is collapsed, not removed (tier 2)", () => {
  const body = Array.from({ length: 3000 }, (_, i) => `line-${i}-payload`).join("\n");
  const msgs: AnyMessage[] = [
    userMsg("go"),
    ...pad("fa", 4),
    assistantTool("b", "build", {}),
    toolResult("b", "build", body),
    ...pad("fb", 4),
  ];
  const res = cleanMessages(asMsgs(msgs), 2);
  assert.equal(res.removed, 0, "collapse keeps the message");
  assert.ok(res.diag.compactedChars > 0, "reports characters saved via compaction");
  assert.ok(res.estimatedTokensSaved > 0);
  // The collapsed body still contains head + tail markers.
  const build = res.messages
    .find((m) => "toolName" in m && (m as { toolName: string }).toolName === "build") as unknown as AnyMessage;
  assert.ok(bodyOf(build).includes("Tool Output Collapsed"));
});

test("cleanMessages: no-op at tier 0 leaves everything untouched", () => {
  const msgs: AnyMessage[] = [
    userMsg("go"),
    assistantTool("r0", "read", { path: "/a.txt" }),
    toolResult("r0", "read", "SAME"),
    assistantTool("r1", "read", { path: "/a.txt" }),
    toolResult("r1", "read", "SAME"),
  ];
  const res = cleanMessages(asMsgs(msgs), 0);
  assert.equal(res.removed, 0);
  assert.equal(res.messages.length, 5);
});
