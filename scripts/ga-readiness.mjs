import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("../", import.meta.url).pathname);
const temporary = mkdtempSync(join(tmpdir(), "polarbear-ga-"));
const repository = join(temporary, "repo");
const data = join(temporary, "data");
const cli = join(root, "dist", "cli.js");
const env = { ...process.env, POLARBEAR_MEMORY_DATA_DIR: data };

function run(command, args, cwd = repository) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: false, timeout: 120_000 });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout;
}

try {
  run("git", ["init", "-q", repository], temporary);
  run(process.execPath, [cli, "init"]);
  const resume = JSON.parse(run(process.execPath, [cli, "benchmark", join(root, "fixtures", "resume-10", "fixture.json")]));
  const retention = JSON.parse(run(process.execPath, [cli, "benchmark", join(root, "fixtures", "retention-180d", "fixture.json")]));
  const security = JSON.parse(run(process.execPath, [cli, "benchmark", join(root, "fixtures", "security", "malicious-memory.json")]));
  const automated = {
    resumePacks: resume.validPacks === 10,
    fileReadReduction: resume.medianFileReadReductionPercent >= 30,
    fixtureTokenReduction: resume.medianTokenReductionPercent >= 40,
    retention: retention.passed === true,
    maliciousMemoryInert: security.passed === true,
  };
  const report = {
    version: "0.1.0",
    automated,
    passed: Object.values(automated).every(Boolean),
    measurements: {
      medianFileReadReductionPercent: resume.medianFileReadReductionPercent,
      medianFixtureTokenReductionPercent: resume.medianTokenReductionPercent,
      validPacks: resume.validPacks,
      automaticArchivePrecisionPercent: retention.treatments.fourLayer.automaticArchivePrecisionPercent,
      criticalLongTermMisarchives: retention.treatments.fourLayer.criticalLongTermMisarchives,
    },
    externalBlockers: [
      "Repeat token benchmark with a real fixed Agent/model; fixture token values are an oracle-backed proxy.",
      "Complete two weeks of dogfood with no P0/P1 data or security defect.",
      "Sign and notarize the macOS artifact with release credentials.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
