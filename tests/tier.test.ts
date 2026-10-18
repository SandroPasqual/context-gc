import { test } from "node:test";
import assert from "node:assert/strict";
import { tierForPercent } from "../src/context-gc.ts";

test("tierForPercent maps usage percent to the right aggressiveness", () => {
  assert.equal(tierForPercent(0), 0);
  assert.equal(tierForPercent(24.9), 0);
  assert.equal(tierForPercent(25), 1);
  assert.equal(tierForPercent(49.9), 1);
  assert.equal(tierForPercent(50), 2);
  assert.equal(tierForPercent(74.9), 2);
  assert.equal(tierForPercent(75), 3);
  assert.equal(tierForPercent(100), 3);
});

test("tierForPercent tolerates negative / absurd values", () => {
  assert.equal(tierForPercent(-10), 0);
});
