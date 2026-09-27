/** Thread-local receipts outlive transcript pruning. They contain no message content. */
export type ChatTurnReceipt = {
  id: string;
  payload_hash: string;
  state: "prepared" | "accepted";
  accepted_at: string | null;
};

type Sql = <T>(strings: TemplateStringsArray, ...values: (string | number | null)[]) => T[];

export class ChatTurnReceipts {
  constructor(private sql: Sql) {
    void sql`CREATE TABLE IF NOT EXISTS workbench_turn_receipts (
      id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'accepted')),
      accepted_at TEXT
    )`;
  }

  get(id: string) {
    return this.sql<ChatTurnReceipt>`SELECT * FROM workbench_turn_receipts WHERE id = ${id}`[0];
  }

  prepare(id: string, payloadHash: string) {
    const prior = this.get(id);
    if (prior) {
      if (prior.payload_hash !== payloadHash)
        throw Object.assign(new Error("Turn key was already used with different content"), {
          code: "idempotency_conflict",
          status: 409,
        });
      return prior;
    }
    // Never evict a receipt and silently make an old key executable again.
    const count = this.sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM workbench_turn_receipts`[0];
    if (count.count >= 10000)
      throw Object.assign(new Error("Thread command limit reached; create another thread"), {
        code: "thread_command_limit",
        status: 429,
      });
    void this.sql`INSERT INTO workbench_turn_receipts (id, payload_hash, state)
      VALUES (${id}, ${payloadHash}, 'prepared')`;
    return this.get(id)!;
  }

  accept(id: string) {
    const now = new Date().toISOString();
    void this
      .sql`UPDATE workbench_turn_receipts SET state = 'accepted', accepted_at = COALESCE(accepted_at, ${now}) WHERE id = ${id}`;
  }

  list() {
    return this.sql<ChatTurnReceipt>`SELECT * FROM workbench_turn_receipts ORDER BY id`;
  }

  purge() {
    void this.sql`DELETE FROM workbench_turn_receipts`;
  }
}
