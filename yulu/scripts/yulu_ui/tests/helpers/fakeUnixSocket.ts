import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface FakeSocket {
  path: string;
  server: Server;
  stop: () => Promise<void>;
}

/**
 * Start a one-shot AF_UNIX echo server that:
 *   - reads everything until client SHUT_WR (server's read returns 0 = EOF)
 *   - parses request as JSON, runs handler(req) -> reply
 *   - writes reply JSON + closes
 *
 * Returns the socket path (always /tmp/yulu_test_<uuid>.sock to dodge
 * macOS's 104-byte AF_UNIX limit — pytest tmp_path is too long).
 */
export function startFakeSocket(
  handler: (req: unknown) => unknown
): Promise<FakeSocket> {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(join(tmpdir(), "yulu_test_"));
    const path = join(tmp, "sock");
    const server = createServer({ allowHalfOpen: true }, (conn) => {
      conn.on("error", () => { /* swallow EPIPE from late writes */ });
      const chunks: Buffer[] = [];
      conn.on("data", (b) => chunks.push(b));
      conn.on("end", async () => {        // client SHUT_WR -> 'end'
        let req: unknown;
        try { req = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { if (!conn.destroyed) conn.end('{"error":"bad json"}\n'); return; }
        try {
          const reply = await handler(req);
          if (!conn.destroyed && conn.writable) conn.end(JSON.stringify(reply) + "\n");
        } catch (_e) {
          if (!conn.destroyed && conn.writable) conn.end('{"error":"handler threw"}\n');
        }
      });
    });
    server.listen(path, () => {
      resolve({
        path,
        server,
        stop: () => new Promise<void>((res) => {
          server.close(() => { rmSync(tmp, { recursive: true, force: true }); res(); });
        }),
      });
    });
  });
}
