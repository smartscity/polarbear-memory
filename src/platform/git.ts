import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

function git(cwd: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 2_000,
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export interface GitContext {
  root: string;
  branch?: string;
  head?: string;
}

export function discoverGitContext(cwd: string): GitContext {
  const rootText = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!rootText) throw new Error(`Not a Git repository: ${cwd}`);
  const root = realpathSync(rootText);
  const branch = git(root, ["branch", "--show-current"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  return {
    root,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
  };
}

export function normalizeRepoFile(root: string, input: string): string {
  const canonicalRoot = realpathSync(root);
  const unresolved = resolve(canonicalRoot, input);
  const absolute = existsSync(unresolved) ? realpathSync(unresolved) : unresolved;
  const repoRelative = relative(canonicalRoot, absolute);
  if (repoRelative === "" || repoRelative === ".") return ".";
  if (repoRelative === ".." || repoRelative.startsWith(`..${sep}`)) {
    throw new Error(`File is outside the repository: ${input}`);
  }
  return repoRelative.split(sep).join("/");
}
