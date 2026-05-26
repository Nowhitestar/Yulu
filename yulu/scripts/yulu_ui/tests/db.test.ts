import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { makeTmpDb } from "./helpers/tmpDb.js";

describe("openDb", () => {
  it("opens an existing sqlite in WAL mode", () => {
    const { path, db } = makeTmpDb("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (42);");
    db.close();
    const conn = openDb(path);
    const row = conn.prepare("SELECT id FROM t LIMIT 1").get() as { id: number };
    expect(row.id).toBe(42);
    const journal = conn.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("wal");
    conn.close();
  });

  it("throws SQLITE_CANTOPEN when path missing", () => {
    expect(() => openDb("/tmp/does-not-exist.sqlite")).toThrow();
  });
});
