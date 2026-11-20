// Rasterize the brand kit SVGs with Chromium, transparent where the art is.
// Usage: node rasterize.mjs <kit_dir> <jobs.json>
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const [kit, jobsFile] = process.argv.slice(2);
const jobs = JSON.parse(readFileSync(jobsFile, "utf8"));

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [src, out, w, h] of jobs) {
  const svg = readFileSync(join(kit, src));
  const url = `data:image/svg+xml;base64,${svg.toString("base64")}`;
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${url}" width="${w}" height="${h}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  mkdirSync(dirname(join(kit, out)), { recursive: true });
  writeFileSync(join(kit, out), png);
}
await browser.close();
console.log(`rendered ${jobs.length} PNGs`);
