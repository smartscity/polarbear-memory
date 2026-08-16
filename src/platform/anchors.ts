import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { FileAnchor } from "../domain/lifecycle.js";
import { normalizeRepoFile } from "./git.js";

const MAX_ANCHOR_BYTES = 2 * 1024 * 1024;

export function digestRepoFile(root: string, path: string): string | undefined {
  const normalized = normalizeRepoFile(root, path);
  const absolute = resolve(root, normalized);
  if (!existsSync(absolute)) return undefined;
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size > MAX_ANCHOR_BYTES) return undefined;
  const bytes = readFileSync(absolute);
  const normalizedBytes = bytes.includes(0)
    ? bytes
    : Buffer.from(bytes.toString("utf8").replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, ""), "utf8");
  return createHash("sha256").update(normalizedBytes).digest("hex");
}

export function captureFileAnchors(root: string, files: string[], commit?: string): FileAnchor[] {
  return [...new Set(files)].map((path) => {
    const normalized = normalizeRepoFile(root, path);
    const digest = digestRepoFile(root, normalized);
    return {
      path: normalized,
      ...(digest ? { contentDigest: digest } : {}),
      ...(commit ? { capturedCommit: commit } : {}),
    };
  });
}
