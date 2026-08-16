import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
const allowedRuntime = new Set(["@modelcontextprotocol/core", "@modelcontextprotocol/server", "zod"]);
const failures = [];

for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path || metadata.dev) continue;
  const name = path.replace(/^node_modules\//, "");
  if (!allowedRuntime.has(name)) failures.push(`unexpected runtime dependency: ${name}`);
  if (metadata.hasInstallScript) failures.push(`runtime install script: ${name}`);
}

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

if (process.argv.includes("--scan-dist")) {
  const dist = join(rootPath, "dist");
  for (const file of filesUnder(dist)) {
    if (extname(file) !== ".js" || file.endsWith(".test.js") || file.includes(`${join("dist", "test")}`)) continue;
    const source = readFileSync(file, "utf8");
    if (/node:(?:http|https|net|tls|dns)/u.test(source) || /\bfetch\s*\(/u.test(source)) {
      failures.push(`network-capable import or fetch in runtime output: ${file}`);
    }
  }
}

if (failures.length > 0) throw new Error(`Runtime dependency policy rejected:\n${failures.join("\n")}`);
console.log(`Runtime dependency policy OK: ${allowedRuntime.size} allowlisted packages, no install scripts.`);
