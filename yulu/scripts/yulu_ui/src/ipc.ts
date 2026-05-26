import { createConnection } from "node:net";

export interface IpcOptions { timeoutMs?: number; }

export async function ipcSend<T = unknown>(
  socketPath: string,
  payload: unknown,
  opts: IpcOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  return new Promise<T>((resolve, reject) => {
    const sock = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      err ? reject(err) : resolve(result as T);
    };
    const timer = setTimeout(() => finish(new Error(`ipcSend timed out after ${timeoutMs}ms (${socketPath})`)), timeoutMs);

    sock.once("connect", () => {
      sock.write(JSON.stringify(payload));
      sock.end();                         // SHUT_WR
    });
    sock.on("data", (b) => chunks.push(b));
    sock.once("end", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return finish(new Error(`ipcSend empty reply from ${socketPath}`));
      try { finish(null, JSON.parse(text) as T); }
      catch (e) { finish(new Error(`ipcSend malformed reply: ${text.slice(0, 80)}`)); }
    });
    sock.once("error", (e) => { clearTimeout(timer); finish(e); });
  });
}
