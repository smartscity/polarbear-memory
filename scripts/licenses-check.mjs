import { readFileSync } from "node:fs";

const allowed = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause"]);
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const failures = [];
let checked = 0;

for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path) continue;
  checked += 1;
  const license = metadata.license;
  if (typeof license !== "string" || !allowed.has(license)) {
    failures.push(`${path}: ${license ?? "missing license"}`);
  }
}

if (failures.length > 0) {
  throw new Error(`License policy rejected:\n${failures.join("\n")}`);
}
console.log(`License policy OK: ${checked} locked packages use allowlisted licenses.`);
