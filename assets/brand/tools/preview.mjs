// Render preview.png: one overview of the whole kit, from the kit's own files.
// Usage: node preview.mjs <kit_dir>
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const kit = process.argv[2];
const img = (rel, style = "") => {
  const type = rel.endsWith(".svg") ? "image/svg+xml" : "image/png";
  return `<img style="${style}" src="data:${type};base64,${readFileSync(join(kit, rel)).toString("base64")}">`;
};
const colors = JSON.parse(readFileSync(join(kit, "colors/colors.json"), "utf8"));
const swatch = (name, light, dark) => `
  <div class="sw"><div class="chip"><span style="background:${light}"></span><span style="background:${dark}"></span></div>
  <div><b>${name}</b><br><code>${light} · ${dark}</code></div></div>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#f6f9fc;color:#0d1114;font:15px/1.5 -apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif}
  .page{width:1600px;padding:64px 72px;box-sizing:border-box;display:flex;flex-direction:column;gap:48px}
  h1{margin:0;font-size:30px} h2{margin:0 0 16px;font-size:16px;color:#51565b;font-weight:600}
  .row{display:flex;gap:40px;align-items:center;flex-wrap:wrap}
  .card{background:#fff;border-radius:14px;box-shadow:0 0 0 1px #dbdee2;padding:28px;display:flex;align-items:center;justify-content:center}
  .dark{background:#16191d;box-shadow:none}
  .label{font-size:12px;color:#646a70;margin-top:8px;text-align:center}
  .sw{display:flex;gap:12px;align-items:center;width:330px}.chip{display:flex;width:56px;height:34px;border-radius:7px;overflow:hidden;box-shadow:0 0 0 1px #dbdee2}.chip span{flex:1}
  code{font-family:ui-monospace,monospace;font-size:12px;color:#51565b}
  .mb{height:30px;border-radius:7px;display:flex;align-items:center;gap:28px;padding:0 18px}
</style></head><body><div class="page">
  <h1>语录 Yulu · 视觉素材包 v1</h1>
  <section><h2>标志</h2><div class="row">
    <div class="card" style="width:560px;height:260px">${img("logo/svg/yulu-mark.svg", "width:432px")}</div>
    <div class="card dark" style="width:560px;height:260px">${img("logo/svg/yulu-mark-on-dark.svg", "width:432px")}</div>
    <div><div class="card" style="width:120px;height:90px">${img("logo/svg/yulu-mark-32px.svg", "width:32px")}&nbsp;&nbsp;${img("logo/svg/yulu-mark-16px.svg", "width:16px")}</div><div class="label">32 / 16 px 母版</div></div>
  </div></section>
  <section><h2>字标组合</h2><div class="row">
    <div class="card" style="padding:32px 40px">${img("lockup/svg/yulu-lockup.svg", "height:72px")}</div>
    <div class="card dark" style="padding:32px 40px">${img("lockup/svg/yulu-lockup-en-on-dark.svg", "height:72px")}</div>
  </div></section>
  <section><h2>App 图标</h2><div class="row">
    ${img("app-icon/png/yulu-app-icon-256.png", "width:200px")}${img("app-icon/png/yulu-app-icon-dark-1024.png", "width:200px")}${img("app-icon/png/yulu-app-icon-mono-1024.png", "width:200px")}
    ${img("app-icon/png/yulu-app-icon-128.png", "width:128px")}${img("app-icon/png/yulu-app-icon-64.png", "width:64px")}${img("app-icon/png/yulu-app-icon-32.png", "width:32px")}${img("app-icon/png/yulu-app-icon-16.png", "width:16px")}
  </div></section>
  <section><h2>菜单栏 · 空闲 / 录音中 / 处理中（@2x 显示）</h2><div class="row">
    <div class="mb" style="background:#f0f3f7;box-shadow:0 0 0 1px #dbdee2">${img("menubar/png/idle-template@2x.png", "width:24px")}${img("menubar/png/recording-light-level4@2x.png", "width:24px")}${img("menubar/png/processing-template-frame2@2x.png", "width:24px")}</div>
    <div class="mb" style="background:#1c1f24">${img("menubar/png/recording-dark-level2@2x.png", "width:24px")}${img("menubar/png/recording-dark-level5@2x.png", "width:24px")}</div>
    <div class="card" style="padding:16px 24px;gap:28px">${img("menubar/svg/idle-template.svg", "width:72px")}${img("menubar/svg/recording-light-level4.svg", "width:72px")}${img("menubar/svg/processing-template-frame2.svg", "width:72px")}</div>
  </div></section>
  <section><h2>分享卡片</h2>${img("social/yulu-social-card.png", "width:640px;border-radius:10px;box-shadow:0 0 0 1px #dbdee2")}</section>
  <section><h2>颜色（浅色 · 深色）</h2><div class="row" style="gap:20px 40px">
    ${swatch("墨", colors.light.ink, colors.dark.ink)}${swatch("纸", colors.light.paper, colors.dark.paper)}${swatch("蓝 · 可点 / 进行中", colors.light.blue, colors.dark.blue)}
    ${swatch("灰", colors.light.gray, colors.dark.gray)}${swatch("发丝线", colors.light.hairline, colors.dark.hairline)}${swatch("红 · 录音中 / 失败", colors.light.red, colors.dark.red)}
  </div></section>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForFunction(() => [...document.images].every((i) => i.complete));
await page.screenshot({ path: join(kit, "preview.png"), fullPage: true });
await browser.close();
console.log("preview.png written");
