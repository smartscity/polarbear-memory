import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeRepoFile } from "./git.js";

test("normalizes repository-relative file paths", () => {
  const root = mkdtempSync(join(tmpdir(), "polarbear-memory-path-"));
  try {
    assert.equal(normalizeRepoFile(root, "src/../src/a.ts"), "src/a.ts");
    assert.throws(() => normalizeRepoFile(root, "../secret.txt"), /outside the repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an existing symlink that escapes the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "polarbear-memory-path-"));
  const outside = mkdtempSync(join(tmpdir(), "polarbear-memory-outside-"));
  try {
    symlinkSync(outside, join(root, "escape"));
    assert.throws(() => normalizeRepoFile(root, "escape"), /outside the repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
