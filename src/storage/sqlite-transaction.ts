import type { DatabaseSync } from "node:sqlite";

/**
 * Executes one synchronous unit of work under SQLite's immediate write lock.
 *
 * Keep transaction ownership at the public store-operation boundary. Repository
 * helpers called by the operation must not start another transaction.
 */
export function inImmediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the operation error. A rollback error is only secondary context.
    }
    throw error;
  }
}
