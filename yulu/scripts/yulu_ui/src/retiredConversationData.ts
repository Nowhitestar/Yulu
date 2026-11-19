import { chmodSync, existsSync, lstatSync, renameSync } from "node:fs";
import { join } from "node:path";

const SESSION_STORE_FILE = "agent-sessions.json";

/**
 * Archive the session store of the retired Yulu-owned conversation (ADR-010).
 *
 * The file holds the user's questions, answers and meeting excerpts. It is
 * renamed once to a private archive and never opened: nothing is parsed, so a
 * damaged file cannot stop the Host, and nothing is sent anywhere.
 */
export function archiveRetiredConversationSessions(durableDataDir: string): string | null {
  const source = join(durableDataDir, SESSION_STORE_FILE);
  if (!existsSync(source) || !lstatSync(source).isFile()) return null;
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let archivePath = join(durableDataDir, `agent-sessions.retired.${stamp}.json`);
  for (let attempt = 1; existsSync(archivePath); attempt += 1) {
    archivePath = join(durableDataDir, `agent-sessions.retired.${stamp}.${attempt}.json`);
  }
  chmodSync(source, 0o600);
  renameSync(source, archivePath);
  return archivePath;
}
