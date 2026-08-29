import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function discover(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...discover(path));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(path);
  }
  return files;
}

const tests = discover("dist-test");
if (tests.length === 0) throw new Error("No compiled tests were found.");
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
