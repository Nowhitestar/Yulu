import { spawn } from "node:child_process";
import { router, publicProcedure } from "../trpc.js";

const PYTHON = "python3";
const TIMEOUT_MS = 20_000;

function runPython(args: string[], scriptDir: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, args, { cwd: scriptDir, env: { ...process.env, PYTHONPATH: scriptDir } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("error", (exc: Error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr || exc.message, code: 999 });
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export const doctorRouter = router({
  run: publicProcedure.query(async ({ ctx }) => {
    const doctor = await runPython(["doctor.py", "--json"], ctx.paths.scriptDir);
    const search = await runPython(["-m", "search.cli", "--doctor"], ctx.paths.scriptDir);
    return {
      ok: doctor.code === 0,
      code: doctor.code,
      report: parseJson(doctor.stdout),
      stdout: doctor.stdout,
      stderr: doctor.stderr,
      search: {
        ok: search.code === 0,
        code: search.code,
        report: parseJson(search.stdout),
        stdout: search.stdout,
        stderr: search.stderr,
      },
    };
  }),
});
