import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";

export interface ClientLease { close(): void }

function clientDirectory(databasePath: string): string { return `${databasePath}.clients`; }
function maintenancePath(databasePath: string): string { return `${databasePath}.maintenance.lock`; }

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function ownerPid(path: string): number {
  try {
    if (!lstatSync(path).isFile()) return 0;
    return Number((JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid);
  } catch { return 0; }
}

function createMaintenanceLock(path: string): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = ownerPid(path);
      if (processIsAlive(pid)) throw new Error("Memory database maintenance is already running.");
      unlinkSync(path);
    }
  }
  throw new Error("Could not acquire the Memory database maintenance lock.");
}

export function acquireClientLease(databasePath: string): ClientLease | undefined {
  if (databasePath === ":memory:") return undefined;
  const directory = clientDirectory(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("Memory client lease path is unsafe.");
  if (existsSync(maintenancePath(databasePath))) throw new Error("Memory database is under maintenance.");
  const path = `${directory}/${process.pid}-${randomUUID()}.lease`;
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (existsSync(maintenancePath(databasePath))) {
    unlinkSync(path);
    throw new Error("Memory database entered maintenance while opening.");
  }
  let closed = false;
  return { close: () => { if (!closed && existsSync(path)) unlinkSync(path); closed = true; } };
}

export function withExclusiveDatabaseMaintenance<T>(databasePath: string, action: () => T): T {
  const lock = maintenancePath(databasePath);
  createMaintenanceLock(lock);
  try {
    const directory = clientDirectory(databasePath);
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".lease")) throw new Error("Memory client lease directory contains an unsafe entry.");
        const path = `${directory}/${entry.name}`;
        let pid = 0;
        try { pid = Number((JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid); } catch { /* invalid lease blocks maintenance */ }
        if (processIsAlive(pid)) throw new Error("Memory database has active clients. Close MCP, CLI and Desktop operations before restoring.");
        unlinkSync(path);
      }
    }
    return action();
  } finally {
    if (existsSync(lock)) unlinkSync(lock);
  }
}
