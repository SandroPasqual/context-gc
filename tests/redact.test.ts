import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/context-gc.ts";

test("redact: JWT is redacted whole (no signature tail leak)", () => {
  const jwt = "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signaturesign";
  const out = redactSecrets(jwt);
  assert.ok(!out.includes("signaturesign"), "signature tail must be gone");
  assert.ok(out.includes("[REDACTED:<jwt>]"));
});

test("redact: generic key/secret/token/redacted", () => {
  assert.equal(redactSecrets("API_KEY=abcd1234efgh5678"), "[REDACTED:<key>]");
  assert.equal(redactSecrets("password=supersecretvalue123"), "[REDACTED:<key>]");
});

test("redact: bearer / basic auth redacted", () => {
  const out = redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345");
  assert.ok(out.includes("[REDACTED:<auth>]"));
});

test("redact: AWS access key id redacted", () => {
  assert.equal(redactSecrets("AKIAIOSFODNN7EXAMPLE"), "[REDACTED:<aws>]");
});

test("redact: long hex blob redacted", () => {
  const hex = "a".repeat(40);
  assert.ok(redactSecrets(hex).includes("[REDACTED:<hex>]"));
});

test("redact: plain non-secret text is preserved", () => {
  assert.equal(redactSecrets("the quick brown fox jumps"), "the quick brown fox jumps");
});

test("redact: empty / falsy returns as-is", () => {
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets(undefined as unknown as string), undefined);
});
