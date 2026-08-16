import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { ProjectBinding } from "../platform/project.js";
import { CURRENT_SCHEMA_VERSION } from "../storage/sqlite-store.js";

export interface BackupInspection {
  path: string;
  fileName: string;
  schemaVersion: number;
  integrity: "ok";
  bytes: number;
  sha256: string;
}

function assertContainedBackup(project: ProjectBinding, input: string): string {
  const backupRoot = join(project.dataDir, "backups");
  const candidate = input.startsWith(sep) ? input : join(backupRoot, input);
  const rel = relative(backupRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Backup must be inside this project's backup directory.");
  if (!existsSync(candidate) || !lstatSync(candidate).isFile()) throw new Error("Backup file does not exist or is not a regular file.");
  return candidate;
}

export function inspectBackup(project: ProjectBinding, input: string): BackupInspection {
  const path = assertContainedBackup(project, input);
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("Backup failed SQLite integrity_check.");
    const hasMigrations = db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get() as { count: number };
    if (hasMigrations.count !== 1) throw new Error("Backup has no schema migration history.");
    const schema = db.prepare("SELECT coalesce(max(version), 0) AS version FROM schema_migrations").get() as { version: number };
    if (schema.version > CURRENT_SCHEMA_VERSION) throw new Error(`Backup schema ${schema.version} requires a newer Engine.`);
    return {
      path,
      fileName: basename(path),
      schemaVersion: schema.version,
      integrity: "ok",
      bytes: lstatSync(path).size,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  } finally {
    db.close();
  }
}

export function listBackups(project: ProjectBinding): BackupInspection[] {
  const root = join(project.dataDir, "backups");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
    .map((entry) => inspectBackup(project, entry.name))
    .sort((left, right) => right.fileName.localeCompare(left.fileName));
}

export function restoreBackup(project: ProjectBinding, input: string): { restored: BackupInspection; rollbackPath?: string } {
  const restored = inspectBackup(project, input);
  mkdirSync(join(project.dataDir, "backups"), { recursive: true, mode: 0o700 });
  const temporary = join(project.dataDir, `.restore-${randomUUID()}.db`);
  copyFileSync(restored.path, temporary);
  const candidate = new DatabaseSync(temporary, { readOnly: true, allowExtension: false });
  try {
    const result = candidate.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (result.integrity_check !== "ok") throw new Error("Copied restore candidate failed integrity_check.");
  } finally {
    candidate.close();
  }

  let rollbackPath: string | undefined;
  const sidecars = [`${project.databasePath}-wal`, `${project.databasePath}-shm`];
  if (existsSync(project.databasePath)) {
    const current = new DatabaseSync(project.databasePath, { allowExtension: false, timeout: 2_000 });
    try {
      current.exec("PRAGMA wal_checkpoint(TRUNCATE); BEGIN EXCLUSIVE; COMMIT;");
    } finally {
      current.close();
    }
    rollbackPath = join(project.dataDir, "backups", `pre-restore-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.db`);
    renameSync(project.databasePath, rollbackPath);
    for (const sidecar of sidecars) if (existsSync(sidecar)) renameSync(sidecar, `${rollbackPath}-${basename(sidecar)}`);
  }
  try {
    renameSync(temporary, project.databasePath);
  } catch (error) {
    if (rollbackPath && existsSync(rollbackPath) && !existsSync(project.databasePath)) renameSync(rollbackPath, project.databasePath);
    throw error;
  }
  return { restored, ...(rollbackPath ? { rollbackPath } : {}) };
}
