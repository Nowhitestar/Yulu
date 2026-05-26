import Database, { type Database as DbType } from "better-sqlite3";

/**
 * Open an existing SQLite DB read-write in WAL mode.
 * Throws if the file doesn't exist (we never create DBs from the UI —
 * setup.sh + Python writers own DB creation).
 */
export function openDb(path: string): DbType {
  const db = new Database(path, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
