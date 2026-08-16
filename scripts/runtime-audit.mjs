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

function scanRuntime(directory, extension, testSuffix, testDirectory) {
  for (const file of filesUnder(directory)) {
    if (extname(file) !== extension || file.endsWith(testSuffix) || file.includes(testDirectory)) continue;
    const source = readFileSync(file, "utf8");
    const isLocalSocketModule = file.includes(`${join("protocol-local")}`);
    const forbiddenImport = isLocalSocketModule
      ? /node:(?:http|https|tls|dns)/u
      : /node:(?:http|https|net|tls|dns)/u;
    if (forbiddenImport.test(source) || /\bfetch\s*\(/u.test(source)) {
      failures.push(`network-capable import or fetch in runtime output: ${file}`);
    }
    if (isLocalSocketModule && /\.listen\s*\(\s*(?:\d|\{)/u.test(source)) {
      failures.push(`TCP-style listen in local socket module: ${file}`);
    }
    if (/\b(?:eval|Function)\s*\(/u.test(source)) failures.push(`dynamic code execution in runtime: ${file}`);
  }
}

if (process.argv.includes("--scan-source")) scanRuntime(join(rootPath, "src"), ".ts", ".test.ts", `${join("src", "test")}`);
if (process.argv.includes("--scan-dist")) scanRuntime(join(rootPath, "dist"), ".js", ".test.js", `${join("dist", "test")}`);

if (failures.length > 0) throw new Error(`Runtime dependency policy rejected:\n${failures.join("\n")}`);
console.log(`Runtime dependency policy OK: ${allowedRuntime.size} allowlisted packages, no install scripts.`);
