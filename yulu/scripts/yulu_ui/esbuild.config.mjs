import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // Inline version metadata so the bundle doesn't need package.json at runtime.
  define: {
    __YULU_UI_NAME__:    JSON.stringify(pkg.name),
    __YULU_UI_VERSION__: JSON.stringify(pkg.version),
  },
  // Externalize native modules — they don't bundle cleanly; npm ci provides them.
  external: ["better-sqlite3", "bufferutil", "utf-8-validate"],
  logLevel: "info",
  sourcemap: true,
  minify: false,
});
