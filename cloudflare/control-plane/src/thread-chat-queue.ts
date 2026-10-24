/**
 * Thread-local payloads for turns parked behind the running one. D1 holds the
 * durable command (identity, hash, order, status); the text and connection
 * token needed to actually run it stay here, next to the transcript they
 * belong to, and leave when the command does.
 */
export type QueuedTurn = {
  command_id: string;
  client_turn_id: string;
  mode: "turn" | "steer";
  message_text: string;
  token: string;
  session_id: string;
  trace_id: string;
  queued_at: string;
};

type Sql = <T>(strings: TemplateStringsArray, ...values: (string | number | null)[]) => T[];

export class QueuedTurnStore {
  constructor(private sql: Sql) {
    void sql`CREATE TABLE IF NOT EXISTS workbench_queued_turns (
      command_id TEXT PRIMARY KEY,
      client_turn_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('turn', 'steer')),
      message_text TEXT NOT NULL,
      token TEXT NOT NULL,
      session_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      queued_at TEXT NOT NULL
    )`;
  }

  put(turn: QueuedTurn) {
    void this.sql`INSERT OR REPLACE INTO workbench_queued_turns
      (command_id, client_turn_id, mode, message_text, token, session_id, trace_id, queued_at)
      VALUES (${turn.command_id}, ${turn.client_turn_id}, ${turn.mode}, ${turn.message_text},
              ${turn.token}, ${turn.session_id}, ${turn.trace_id}, ${turn.queued_at})`;
  }

  get(commandId: string) {
    return this
      .sql<QueuedTurn>`SELECT * FROM workbench_queued_turns WHERE command_id = ${commandId}`[0];
  }

  /** Oldest first; ties break on command id, matching D1's queue order. */
  list() {
    return this
      .sql<QueuedTurn>`SELECT * FROM workbench_queued_turns ORDER BY queued_at, command_id`;
  }

  delete(commandId: string) {
    void this.sql`DELETE FROM workbench_queued_turns WHERE command_id = ${commandId}`;
  }

  purge() {
    void this.sql`DELETE FROM workbench_queued_turns`;
  }
}
