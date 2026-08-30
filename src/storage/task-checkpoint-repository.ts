import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  TASK_PHASES, TASK_STATUSES, validateCheckpointState,
  type Checkpoint, type CheckpointState, type Task, type TaskPhase, type TaskStatus,
} from "../domain/context-os.js";
import { inImmediateTransaction } from "./sqlite-transaction.js";

interface TaskRow {
  id: string; project_id: string; title: string; objective: string; status: TaskStatus; phase: TaskPhase;
  priority_milli: number; parent_task_id: string | null; last_checkpoint_id: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
}

interface CheckpointRow {
  id: string; project_id: string; task_id: string; execution_run_id: string | null;
  previous_checkpoint_id: string | null; status: TaskStatus; phase: TaskPhase; summary: string;
  state_json: string; delta_json: string; created_at: string;
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id, projectId: row.project_id, title: row.title, objective: row.objective,
    status: row.status, phase: row.phase, priority: row.priority_milli,
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.last_checkpoint_id ? { lastCheckpointId: row.last_checkpoint_id } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function checkpointFromRow(row: CheckpointRow): Checkpoint {
  return {
    id: row.id, projectId: row.project_id, taskId: row.task_id,
    ...(row.execution_run_id ? { executionRunId: row.execution_run_id } : {}),
    ...(row.previous_checkpoint_id ? { previousCheckpointId: row.previous_checkpoint_id } : {}),
    status: row.status, phase: row.phase, summary: row.summary,
    state: JSON.parse(row.state_json) as CheckpointState,
    delta: JSON.parse(row.delta_json) as Partial<CheckpointState>, createdAt: row.created_at,
  };
}

export class TaskCheckpointRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  createTask(projectId: string, input: {
    title: string; objective: string; phase?: TaskPhase; priority?: number; parentTaskId?: string;
  }): Task {
    const title = input.title.trim();
    const objective = input.objective.trim();
    if (!title || !objective) throw new Error("Task title and objective must not be empty.");
    if (Buffer.byteLength(title, "utf8") > 1_024 || Buffer.byteLength(objective, "utf8") > 16_384) {
      throw new Error("Task title or objective exceeds its size limit.");
    }
    const priority = input.priority ?? 500;
    if (!Number.isInteger(priority) || priority < 0 || priority > 1_000) {
      throw new Error("Task priority must be an integer between 0 and 1000.");
    }
    if (input.parentTaskId && !this.getTask(projectId, input.parentTaskId)) {
      throw new Error(`Parent task not found: ${input.parentTaskId}`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO tasks(id, project_id, title, objective, status, phase, priority_milli, parent_task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?)
    `).run(id, projectId, title, objective, input.phase ?? "DISCOVERY", priority, input.parentTaskId ?? null, now, now);
    return this.requireTask(projectId, id);
  }

  getTask(projectId: string, taskId: string): Task | undefined {
    const row = this.#database.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?")
      .get(projectId, taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  requireTask(projectId: string, taskId: string): Task {
    const task = this.getTask(projectId, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  listTasks(projectId: string, status?: TaskStatus): Task[] {
    const rows = status
      ? this.#database.prepare("SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY priority_milli DESC, updated_at DESC").all(projectId, status)
      : this.#database.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY priority_milli DESC, updated_at DESC").all(projectId);
    return (rows as unknown as TaskRow[]).map(taskFromRow);
  }

  latestCheckpoint(projectId: string, taskId: string): Checkpoint | undefined {
    const task = this.requireTask(projectId, taskId);
    if (!task.lastCheckpointId) return undefined;
    // The task pointer is the durable chain head; checkpoint timestamps can tie at millisecond resolution.
    const row = this.#database.prepare(`
      SELECT * FROM checkpoints WHERE project_id = ? AND task_id = ? AND id = ?
    `).get(projectId, taskId, task.lastCheckpointId) as CheckpointRow | undefined;
    if (!row) throw new Error(`Task points to a missing checkpoint: ${task.lastCheckpointId}`);
    return checkpointFromRow(row);
  }

  listCheckpoints(projectId: string, taskId: string, limit = 20): Checkpoint[] {
    this.requireTask(projectId, taskId);
    const rows = this.#database.prepare(`
      SELECT * FROM checkpoints WHERE project_id = ? AND task_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(projectId, taskId, limit) as unknown as CheckpointRow[];
    return rows.map(checkpointFromRow);
  }

  checkpoint(projectId: string, input: {
    taskId: string; executionRunId?: string; status: TaskStatus; phase: TaskPhase; summary: string;
    state: CheckpointState; delta?: Partial<CheckpointState>; idempotencyKey?: string;
  }): Checkpoint {
    const task = this.requireTask(projectId, input.taskId);
    const summary = input.summary.trim();
    if (!summary) throw new Error("Checkpoint summary must not be empty.");
    if (!TASK_STATUSES.includes(input.status) || !TASK_PHASES.includes(input.phase)) {
      throw new Error("Checkpoint status or phase is invalid.");
    }
    const validatedState = validateCheckpointState(input.state);
    const stateJson = JSON.stringify(validatedState);
    const deltaJson = JSON.stringify(input.delta ?? {});
    if (Buffer.byteLength(stateJson, "utf8") > 128 * 1024) throw new Error("Checkpoint state exceeds 128 KiB.");
    if (input.executionRunId) {
      const run = this.#database.prepare(`
        SELECT 1 FROM execution_runs WHERE project_id = ? AND id = ? AND (task_id IS NULL OR task_id = ?)
      `).get(projectId, input.executionRunId, input.taskId);
      if (!run) throw new Error(`Execution run not found for task: ${input.executionRunId}`);
    }
    const fingerprint = createHash("sha256").update(input.idempotencyKey
      ?? `${input.taskId}\0${input.executionRunId ?? ""}\0${input.status}\0${input.phase}\0${summary}\0${stateJson}\0${deltaJson}`)
      .digest("hex");
    const existing = this.#database.prepare("SELECT * FROM checkpoints WHERE task_id = ? AND source_fingerprint = ?")
      .get(input.taskId, fingerprint) as CheckpointRow | undefined;
    if (existing) return checkpointFromRow(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        INSERT INTO checkpoints(
          id, project_id, task_id, execution_run_id, previous_checkpoint_id, status, phase,
          summary, state_json, delta_json, source_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, input.taskId, input.executionRunId ?? null, task.lastCheckpointId ?? null,
        input.status, input.phase, summary, stateJson, deltaJson, fingerprint, now,
      );
      this.#database.prepare(`
        UPDATE tasks SET status = ?, phase = ?, last_checkpoint_id = ?, updated_at = ?,
          completed_at = CASE WHEN ? IN ('DONE','CANCELLED') THEN coalesce(completed_at, ?) ELSE NULL END
        WHERE project_id = ? AND id = ?
      `).run(input.status, input.phase, id, now, input.status, now, projectId, input.taskId);
      if (input.executionRunId) {
        this.#database.prepare("UPDATE execution_runs SET checkpoint_id = ? WHERE project_id = ? AND id = ?")
          .run(id, projectId, input.executionRunId);
      }
    });
    const inserted = this.#database.prepare(`
      SELECT * FROM checkpoints WHERE project_id = ? AND task_id = ? AND id = ?
    `).get(projectId, input.taskId, id) as CheckpointRow | undefined;
    if (!inserted) throw new Error(`Checkpoint was not persisted: ${id}`);
    return checkpointFromRow(inserted);
  }
}
