import assert from "node:assert/strict";
import { test } from "node:test";
import { redactText } from "./redaction.js";

test("redacts credentials, bearer tokens, private keys and home paths", () => {
  const input = [
    "token=super-secret-value",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "password='a secret with spaces'",
    "https://build-user:database-password@example.test/db",
    "AKIAABCDEFGHIJKLMNOP",
    "eyJabcdefgh.ijklmnop.qrstuvwx",
    "/Users/alice/project",
    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
  ].join("\n");
  const redacted = redactText(input, "/Users/alice");
  assert.doesNotMatch(redacted, /super-secret-value|abcdefghijklmnopqrstuvwxyz123456|a secret with spaces|database-password|AKIAABCDEFGHIJKLMNOP|eyJabcdefgh|\/Users\/alice|BEGIN PRIVATE KEY/u);
  assert.match(redacted, /<redacted>/u);
});
