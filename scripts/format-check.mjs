import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const included = ["src", "scripts", "docs", "fixtures", "api"];
const extensions = new Set([".ts", ".mjs", ".md", ".json"]);
const failures = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (extensions.has(extname(path))) {
      const source = readFileSync(path, "utf8");
      if (source.includes("\r")) failures.push(`${path}: CRLF is not allowed`);
      source.split("\n").forEach((line, index) => {
        if (/[ \t]+$/u.test(line) && !(extname(path) === ".md" && line.endsWith("  "))) {
          failures.push(`${path}:${index + 1}: trailing whitespace`);
        }
        if (line.includes("\t")) failures.push(`${path}:${index + 1}: tab indentation`);
      });
      if (!source.endsWith("\n")) failures.push(`${path}: missing final newline`);
    }
  }
}

for (const directory of included) walk(join(root, directory));
if (failures.length > 0) throw new Error(`Format policy rejected:\n${failures.join("\n")}`);
console.log("Format policy OK: UTF-8/LF, no tabs or trailing whitespace.");
