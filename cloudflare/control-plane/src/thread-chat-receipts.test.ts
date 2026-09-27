import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTurnReceipts } from "./thread-chat-receipts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const fixture = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql = <T>(strings: TemplateStringsArray, ...values: (string | number | null)[]) =>
    db.prepare(strings.join("?")).all(...values) as T[];
  return { db, sql, receipts: new ChatTurnReceipts(sql) };
};

describe("durable chat command receipts", () => {
  it("retains accepted identity independently of transcripts and process reconstruction", () => {
    const { sql, receipts } = fixture();
    receipts.prepare("turn", "hash");
    receipts.accept("turn");
    const reloaded = new ChatTurnReceipts(sql);
    expect(reloaded.prepare("turn", "hash")).toMatchObject({ state: "accepted" });
    expect(() => reloaded.prepare("turn", "changed")).toThrow("different content");
    expect(reloaded.list()).toHaveLength(1);
  });

  it("can resume a prepared acceptance and exports and purges receipts with its thread", () => {
    const { sql, receipts } = fixture();
    receipts.prepare("turn", "hash");
    const reloaded = new ChatTurnReceipts(sql);
    expect(reloaded.prepare("turn", "hash").state).toBe("prepared");
    reloaded.accept("turn");
    const accepted = reloaded.list();
    reloaded.accept("turn");
    expect(reloaded.list()).toEqual(accepted);
    reloaded.purge();
    expect(reloaded.list()).toEqual([]);
  });

  it("fails closed at its bound instead of evicting old keys", () => {
    const { db, receipts } = fixture();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO workbench_turn_receipts SELECT CAST(i AS TEXT), 'hash', 'accepted', 'now' FROM n`);
    expect(() => receipts.prepare("new", "hash")).toThrow("command limit");
    expect(receipts.prepare("1", "hash").state).toBe("accepted");
  });
});
