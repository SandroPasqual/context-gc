import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseToolResult } from "../src/context-gc.ts";
import { toolResult, longText, asMsg } from "./helpers.ts";

const HEAD = 5;
const TAIL = 50;

test("collapse: small body is untouched", () => {
  const m = asMsg(toolResult("r", "build", "line-0\nline-1\nline-2"));
  const res = collapseToolResult(m, 4000);
  assert.equal(res.collapsed, false);
  assert.equal(res.removedChars, 0);
});

test("collapse: empty / non-array content is a safe no-op", () => {
  const res = collapseToolResult({ role: "toolResult" } as never, 4000);
  assert.equal(res.collapsed, false);
});

test("collapse: long body keeps head + tail and inserts a placeholder", () => {
  const body = longText(2000);
  const m = asMsg(toolResult("r", "build", body));
  const res = collapseToolResult(m, 4000);

  assert.equal(res.collapsed, true);
  assert.ok(res.removedChars > 0, "should report removed characters");

  const lines = (res.content as Array<{ type: string; text: string }>)[0].text.split("\n");
  // head (5) + placeholder line (1) + tail (50)
  assert.equal(lines.length, HEAD + 1 + TAIL);
  assert.ok(lines[HEAD].includes("Tool Output Collapsed"), "placeholder present");
  assert.ok(lines[0].startsWith("line-0-"), "head preserved");
  assert.ok(lines[lines.length - 1].startsWith("line-1999-"), "tail preserved");
});

test("collapse: enough lines but under the char budget is NOT collapsed", () => {
  // 100 lines but each short -> under 4000 chars
  const body = longText(100);
  assert.ok(body.length < 4000);
  const res = collapseToolResult(asMsg(toolResult("r", "build", body)), 4000);
  assert.equal(res.collapsed, false);
});

test("collapse: too few lines collapses nothing", () => {
  // 8 short lines -> only 8 lines (<< 55), but > 4000 chars total.
  const body = Array.from({ length: 8 }, () => "x".repeat(500)).join("\n");
  const res = collapseToolResult(asMsg(toolResult("r", "build", body)), 4000);
  assert.equal(res.collapsed, false);
});
