import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { router, publicProcedure } from "../trpc.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "..", "package.json"), "utf8")) as { name: string; version: string };

export const systemRouter = router({
  version: publicProcedure.query(() => ({
    name: PKG.name,
    version: PKG.version,
    node: process.version,
    uptimeSec: Math.floor(process.uptime()),
  })),
});
