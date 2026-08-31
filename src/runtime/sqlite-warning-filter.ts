export const SQLITE_EXPERIMENTAL_WARNING_MESSAGE = "SQLite is an experimental feature and might change at any time";

let installed = false;

export function installSqliteExperimentalWarningFilter(): void {
  if (installed) return;
  installed = true;
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning;
    const warningType = warning instanceof Error ? warning.name : readWarningType(args[0]);
    if (message === SQLITE_EXPERIMENTAL_WARNING_MESSAGE && warningType === "ExperimentalWarning") return;
    Reflect.apply(emitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;
}

function readWarningType(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}
