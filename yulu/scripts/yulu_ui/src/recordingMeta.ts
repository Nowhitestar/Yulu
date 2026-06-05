/**
 * Per-recording editable metadata stored as filesystem sidecars next to the
 * `<stem>.wav` — keeping Yulu's local-first, "a recording is a set of files"
 * model. No SQLite migration, no Python coupling.
 *
 *   <stem>.title      — plain-text custom title (one line). Already an
 *                       established convention: voicemail/recorder.py writes it
 *                       and voicemail/repo.py reads it as title-override #1.
 *   <stem>.tags.json  — JSON array of tag strings.
 *
 * Both are optional; absence means "no override / no tags".
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

/** Normalize a tag list: trim, drop empties, case-insensitive de-dupe
 *  (first spelling wins), cap length so a stray paste can't bloat the sidecar. */
export function normalizeTags(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const t = String(raw).trim().slice(0, 64);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

/** Read the `<stem>.title` sidecar. Returns null when absent/empty. */
export function readTitleSidecar(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const t = readFileSync(path, "utf8").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Write the `<stem>.title` sidecar. Empty/whitespace removes it (clears the
 *  override so the filename-derived title shows again). Trailing newline keeps
 *  it byte-compatible with the Python writer (recorder.py). */
export function writeTitleSidecar(path: string, title: string): void {
  const t = title.trim();
  if (!t) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  writeFileSync(path, t + "\n", "utf8");
}

/** Read the `<stem>.tags.json` sidecar. Tolerates a malformed/legacy file by
 *  returning []. */
export function readTagsSidecar(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return normalizeTags(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return [];
  }
}

/** Write the `<stem>.tags.json` sidecar. An empty list removes the file. */
export function writeTagsSidecar(path: string, tags: readonly string[]): string[] {
  const norm = normalizeTags(tags);
  if (norm.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return [];
  }
  writeFileSync(path, JSON.stringify(norm) + "\n", "utf8");
  return norm;
}
