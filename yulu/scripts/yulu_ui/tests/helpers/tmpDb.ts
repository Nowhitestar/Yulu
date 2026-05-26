import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function makeTmpDb(schema: string): { path: string; db: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), "yulu_db_"));
  const path = join(dir, "test.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(schema);
  return { path, db };
}
