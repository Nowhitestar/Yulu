"""Write the Yulu brand kit SVG sources and the raster job list.

Usage: python3 -I build_svgs.py <fonts_dir> <out_dir>
Run through build.sh, which also fetches the fonts, rasterizes, and copies the
product icons into place.
"""
import json
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONTS = Path(sys.argv[1])
OUT = Path(sys.argv[2])

INK = "#0d1114"
INK_DARK = "#eceff2"
BLUE = "#0f74c5"
BLUE_DARK = "#3a93e6"
PAPER = "#f6f9fc"
GRAY = "#646a70"
RED = "#ff3b30"
RED_DARK = "#ff453a"


def r(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


# --- the mark -------------------------------------------------------------

def wave(level=1.0):
    """Primary mark ink path (viewBox 0 0 144 64); level scales the swells."""
    b = 36
    c1, c2, c3, c4 = b - 29.3 * level, b + 19 * level, b + 21 * level, b - 11.55 * level
    return (f"M10 36C14 {r(c1)} 22 {r(c1)} 26 36C28.6 {r(c2)} 36 {r(c3)} 40 36"
            f"C42.2 {r(c4)} 47 36 52 36H100")


CURSOR = "M116 36H134"
MASTER32_INK = "M3.5 17.5C4.3 10.5 5.9 10.5 6.7 17.5C7.2 22.1 8.7 22.5 9.5 17.5C9.9 14.7 10.9 17.5 11.9 17.5H20.2"
MASTER32_CURSOR = "M24.7 17.5H28.3"
MASTER16_INK = "M2 8.5C2.6 3.2 3.8 3.2 4.4 8.5C4.8 11.6 5.9 12 6.4 8.5C6.6 7.3 7.1 8.5 7.6 8.5H9.4"
MASTER16_CURSOR = "M12 8.5H14"


def menubar_wave(level=1.0):
    b = 8.6
    c1, c2, c3, c4 = b - 5.86 * level, b + 3.8 * level, b + 4.2 * level, b - 2.31 * level
    return (f"M2.85 8.6C3.5 {r(c1)} 4.7 {r(c1)} 5.33 8.6C5.73 {r(c2)} 6.9 {r(c3)} 7.5 8.6"
            f"C7.84 {r(c4)} 8.6 8.6 9.36 8.6H15.6")


def stroke(d, color, width, extra=""):
    return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" '
            f'stroke-linecap="round" stroke-linejoin="round"{extra}/>')


def svg(w, h, body, title, view=None, desc=None):
    view = view or f"0 0 {r(w)} {r(h)}"
    desc = f"<desc>{desc}</desc>\n" if desc else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{r(w)}" height="{r(h)}" viewBox="{view}" '
            f'role="img" aria-label="{title}">\n<title>{title}</title>\n{desc}{body}\n</svg>\n')


def mark_body(ink, blue, level=1.0):
    return stroke(wave(level), ink, 10) + "\n" + stroke(CURSOR, blue, 10)


# --- outlined text --------------------------------------------------------

class Face:
    def __init__(self, filename):
        self.font = TTFont(FONTS / filename)
        self.glyphs = self.font.getGlyphSet()
        self.cmap = self.font.getBestCmap()
        self.upm = self.font["head"].unitsPerEm
        self.hmtx = self.font["hmtx"]

    def layout(self, text, size, x, baseline, tracking=0.0):
        """Return (svg path d, advance width, bbox) for text set on a baseline."""
        scale = size / self.upm
        pen = SVGPathPen(self.glyphs)
        bounds = BoundsPen(self.glyphs)
        cursor = 0.0
        for ch in text:
            gid = self.cmap.get(ord(ch))
            if gid is None:
                raise SystemExit(f"missing glyph {ch!r}")
            t = (scale, 0, 0, -scale, x + cursor * scale, baseline)
            self.glyphs[gid].draw(TransformPen(pen, t))
            self.glyphs[gid].draw(TransformPen(bounds, t))
            cursor += self.hmtx[gid][0] + tracking * self.upm
        cursor -= tracking * self.upm
        return pen.getCommands(), cursor * scale, bounds.bounds


ZH = Face("notoserif-sc-700.ttf")
YULU = Face("fraunces-600-144.ttf")
SERIF = Face("fraunces-400-72.ttf")
SANS = Face("inter-400.ttf")


def lockup(ink, blue, with_zh=True):
    """Mark + 语录 + Yulu (or mark + Yulu) on one line, in mark units."""
    parts = [mark_body(ink, blue)]
    x = 144 + 22
    zh_size, en_size = 49, 46
    # Put the Chinese glyphs' optical centre on the mark's centre line.
    _, _, zb = ZH.layout("语录", zh_size, 0, 0)
    baseline = 32.5 - (zb[1] + zb[3]) / 2
    if with_zh:
        d, adv, _ = ZH.layout("语录", zh_size, x, baseline, tracking=0.04)
        parts.append(f'<path d="{d}" fill="{ink}"/>')
        x += adv + 26
    d, adv, _ = YULU.layout("Yulu", en_size, x, baseline, tracking=-0.02)
    parts.append(f'<path d="{d}" fill="{ink}"/>')
    width = x + adv + 8
    return width, "\n".join(parts)


# --- app icon -------------------------------------------------------------

SQUIRCLE = '<rect x="100" y="100" width="824" height="824" rx="185"/>'


def app_icon(fill, edge, edge_opacity, ink, blue, blue_opacity=1.0, shadow=True):
    defs = ('<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%">'
            '<feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#0d1114" flood-opacity="0.22"/>'
            '</filter></defs>') if shadow else ""
    body = (f'{defs}<g{" filter=\"url(#s)\"" if shadow else ""}>'
            f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{fill}" '
            f'stroke="{edge}" stroke-opacity="{edge_opacity}" stroke-width="4"/></g>\n'
            f'<g transform="translate(233 394) scale(3.88)">'
            f'{stroke(wave(), ink, 10)}'
            f'{stroke(CURSOR, blue, 10, f" stroke-opacity=\"{blue_opacity}\"" if blue_opacity < 1 else "")}</g>')
    return body


def app_icon_small(view, master_ink, master_cursor, master_w, fill, ink, blue):
    """A squircle with a pixel master, for 16 and 32 px icon sizes."""
    side = view * 824 / 1024
    off = (view - side) / 2
    rx = side * 185 / 824
    scale = side * 0.84 / master_w
    tx = view / 2 - master_w * scale / 2
    ty = view / 2 - (master_w / 2) * scale + view * 0.01
    sw = 2.0
    return (f'<rect x="{r(off)}" y="{r(off)}" width="{r(side)}" height="{r(side)}" rx="{r(rx)}" fill="{fill}" '
            f'stroke="{INK}" stroke-opacity="0.2" stroke-width="{r(view / 64)}"/>\n'
            f'<g transform="translate({r(tx)} {r(ty)}) scale({r(scale)})">'
            f'{stroke(master_ink, ink, sw)}{stroke(master_cursor, blue, sw)}</g>')


# --- write ----------------------------------------------------------------

files = {}
jobs = []  # (svg, png, width, height)


def put(rel, content):
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    files[rel] = content


# Mark
put("logo/svg/yulu-mark.svg", svg(144, 64, mark_body(INK, BLUE), "语录 Yulu 标志"))
put("logo/svg/yulu-mark-on-dark.svg", svg(144, 64, mark_body(INK_DARK, BLUE_DARK), "语录 Yulu 标志（深色背景）"))
put("logo/svg/yulu-mark-black.svg", svg(144, 64, mark_body(INK, INK), "语录 Yulu 标志（单色黑）"))
put("logo/svg/yulu-mark-white.svg", svg(144, 64, mark_body("#ffffff", "#ffffff"), "语录 Yulu 标志（单色白）"))
put("logo/svg/yulu-mark-32px.svg", svg(32, 32, stroke(MASTER32_INK, INK, 3) + stroke(MASTER32_CURSOR, BLUE, 3), "语录 Yulu 标志 32 px 母版"))
put("logo/svg/yulu-mark-16px.svg", svg(16, 16, stroke(MASTER16_INK, INK, 2) + stroke(MASTER16_CURSOR, BLUE, 2), "语录 Yulu 标志 16 px 母版"))
for name in ("yulu-mark", "yulu-mark-on-dark", "yulu-mark-black", "yulu-mark-white"):
    for factor, suffix in ((2, ""), (4, "@2x"), (8, "@4x")):
        jobs.append((f"logo/svg/{name}.svg", f"logo/png/{name}{suffix}.png", 144 * factor, 64 * factor))

# Lockups
for name, ink, blue, zh in (
    ("yulu-lockup", INK, BLUE, True),
    ("yulu-lockup-on-dark", INK_DARK, BLUE_DARK, True),
    ("yulu-lockup-en", INK, BLUE, False),
    ("yulu-lockup-en-on-dark", INK_DARK, BLUE_DARK, False),
):
    width, body = lockup(ink, blue, zh)
    put(f"lockup/svg/{name}.svg", svg(width, 64, body, "语录 Yulu 字标组合"))
    jobs.append((f"lockup/svg/{name}.svg", f"lockup/png/{name}@2x.png", round(width * 4), 256))

# App icon
put("app-icon/svg/yulu-app-icon.svg", svg(1024, 1024, app_icon("#fbfcfd", INK, 0.08, INK, BLUE), "语录 App 图标"))
put("app-icon/svg/yulu-app-icon-dark.svg", svg(1024, 1024, app_icon("#16191d", "#ffffff", 0.08, INK_DARK, BLUE_DARK), "语录 App 图标（深色）"))
put("app-icon/svg/yulu-app-icon-mono.svg", svg(1024, 1024, app_icon("#e4e8ed", INK, 0.06, "#3d4349", "#3d4349", 0.55), "语录 App 图标（单色）"))
put("app-icon/svg/yulu-app-icon-32px.svg", svg(32, 32, app_icon_small(32, MASTER16_INK, MASTER16_CURSOR, 16, "#fbfcfd", INK, BLUE), "语录 App 图标 32 px"))
put("app-icon/svg/yulu-app-icon-16px.svg", svg(16, 16, app_icon_small(16, MASTER16_INK, MASTER16_CURSOR, 16, "#fbfcfd", INK, BLUE), "语录 App 图标 16 px"))
for size in (1024, 512, 256, 128, 64):
    jobs.append(("app-icon/svg/yulu-app-icon.svg", f"app-icon/png/yulu-app-icon-{size}.png", size, size))
jobs.append(("app-icon/svg/yulu-app-icon-32px.svg", "app-icon/png/yulu-app-icon-32.png", 32, 32))
jobs.append(("app-icon/svg/yulu-app-icon-16px.svg", "app-icon/png/yulu-app-icon-16.png", 16, 16))
jobs.append(("app-icon/svg/yulu-app-icon-dark.svg", "app-icon/png/yulu-app-icon-dark-1024.png", 1024, 1024))
jobs.append(("app-icon/svg/yulu-app-icon-mono.svg", "app-icon/png/yulu-app-icon-mono-1024.png", 1024, 1024))
iconset = {
    "icon_16x16.png": ("app-icon/svg/yulu-app-icon-16px.svg", 16),
    "icon_16x16@2x.png": ("app-icon/svg/yulu-app-icon-32px.svg", 32),
    "icon_32x32.png": ("app-icon/svg/yulu-app-icon-32px.svg", 32),
    "icon_32x32@2x.png": ("app-icon/svg/yulu-app-icon.svg", 64),
    "icon_128x128.png": ("app-icon/svg/yulu-app-icon.svg", 128),
    "icon_128x128@2x.png": ("app-icon/svg/yulu-app-icon.svg", 256),
    "icon_256x256.png": ("app-icon/svg/yulu-app-icon.svg", 256),
    "icon_256x256@2x.png": ("app-icon/svg/yulu-app-icon.svg", 512),
    "icon_512x512.png": ("app-icon/svg/yulu-app-icon.svg", 512),
    "icon_512x512@2x.png": ("app-icon/svg/yulu-app-icon.svg", 1024),
}
for png, (src, size) in iconset.items():
    jobs.append((src, f"app-icon/Yulu.iconset/{png}", size, size))

# Menu bar
MB_W, MB_H = 24, 16
def mb_svg(body, title):
    return svg(MB_W, MB_H, body, title)

put("menubar/svg/idle-template.svg", mb_svg(stroke(menubar_wave(), "#000000", 1.9) + stroke("M19.3 8.6H22.1", "#000000", 1.9), "菜单栏：空闲（模板图标）"))
for theme, ink, red in (("light", INK, RED), ("dark", INK_DARK, RED_DARK)):
    for i, level in enumerate((0.3, 0.55, 0.8, 1.0, 1.15), start=1):
        put(f"menubar/svg/recording-{theme}-level{i}.svg",
            mb_svg(stroke(menubar_wave(level), ink, 1.9) + f'<circle cx="20.6" cy="8.6" r="3.1" fill="{red}"/>',
                   f"菜单栏：录音中，音量档 {i}"))
for i, ops in enumerate(((1, .3, .3), (.3, 1, .3), (.3, .3, 1)), start=1):
    dots = "".join(f'<circle cx="{cx}" cy="8.6" r="1.05" fill="#000000" fill-opacity="{o}"/>'
                   for cx, o in zip((18.3, 20.6, 22.9), ops))
    put(f"menubar/svg/processing-template-frame{i}.svg", mb_svg(stroke(menubar_wave(), "#000000", 1.9) + dots, f"菜单栏：处理中，第 {i} 帧（模板图标）"))
for path in sorted(p for p in files if p.startswith("menubar/svg/")):
    stem = Path(path).stem
    jobs.append((path, f"menubar/png/{stem}.png", MB_W, MB_H))
    jobs.append((path, f"menubar/png/{stem}@2x.png", MB_W * 2, MB_H * 2))

# Animated references (SMIL, so the stroke stays even at any size)
levels = (1, 0.45, 0.9, 0.3, 1.1, 0.6, 1)
times = "0;0.18;0.34;0.52;0.7;0.86;1"
voice = (f'<path d="{wave()}" fill="none" stroke="{INK}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">'
         f'<animate attributeName="d" dur="2.4s" repeatCount="indefinite" keyTimes="{times}" '
         f'values="{";".join(wave(l) for l in levels)}"/></path>')
cursor = (f'<path d="M116 36H134" fill="none" stroke="{BLUE}" stroke-width="10" stroke-linecap="round">'
          f'<animate attributeName="d" dur="3.6s" repeatCount="indefinite" keyTimes="0;0.33;0.72;0.89;1" '
          f'values="M116 36H118.7;M116 36H134;M116 36H134;M116 36H118.7;M116 36H118.7"/></path>')
put("motion/yulu-mark-recording.svg", svg(144, 64, voice + "\n" + cursor, "语录标志录音动效"))
mb_levels = (0.5, 1, 0.35, 0.9, 0.6, 1.1, 0.4, 0.5)
mb_times = "0;0.15;0.3;0.45;0.6;0.75;0.9;1"
put("motion/menubar-recording.svg", svg(MB_W, MB_H,
    f'<path d="{menubar_wave()}" fill="none" stroke="{INK}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
    f'<animate attributeName="d" dur="1.4s" repeatCount="indefinite" keyTimes="{mb_times}" '
    f'values="{";".join(menubar_wave(l) for l in mb_levels)}"/></path>'
    f'<circle cx="20.6" cy="8.6" r="3.1" fill="{RED}"/>', "菜单栏录音动效"))
dots = "".join(
    f'<circle cx="{cx}" cy="8.6" r="1.05" fill="{INK}" fill-opacity="0.3">'
    f'<animate attributeName="fill-opacity" dur="1.2s" begin="{d}s" repeatCount="indefinite" keyTimes="0;0.2;0.45;1" values="0.3;1;0.3;0.3"/></circle>'
    for cx, d in ((18.3, 0), (20.6, 0.4), (22.9, 0.8)))
put("motion/menubar-processing.svg", svg(MB_W, MB_H, stroke(menubar_wave(), INK, 1.9) + dots, "菜单栏处理中动效"))

# Favicon
# The favicon follows the browser's light / dark scheme.
FAVICON_STYLE = (f"<style>.i{{stroke:{INK}}}.c{{stroke:{BLUE}}}"
                 f"@media (prefers-color-scheme:dark){{.i{{stroke:{INK_DARK}}}.c{{stroke:{BLUE_DARK}}}}}</style>")
put("favicon/favicon.svg", svg(32, 32, FAVICON_STYLE + stroke(MASTER32_INK, INK, 3, ' class="i"')
                               + stroke(MASTER32_CURSOR, BLUE, 3, ' class="c"'), "语录"))
jobs += [
    ("logo/svg/yulu-mark-16px.svg", "favicon/favicon-16.png", 16, 16),
    ("favicon/favicon.svg", "favicon/favicon-32.png", 32, 32),
    ("favicon/favicon.svg", "favicon/favicon-48.png", 48, 48),
    ("app-icon/svg/yulu-app-icon.svg", "favicon/apple-touch-icon.png", 180, 180),
]

# Social card 1280 x 640
W, H = 1280, 640
parts = [f'<rect width="{W}" height="{H}" fill="{PAPER}"/>',
         f'<g transform="translate(88 64) scale(2.5)">{mark_body(INK, BLUE)}</g>']
zh_d, zh_adv, _ = ZH.layout("语录", 76, 88, 452, tracking=0.04)
parts.append(f'<path d="{zh_d}" fill="{INK}"/>')
en_d, _, _ = YULU.layout("Yulu", 70, 88 + zh_adv + 30, 452, tracking=-0.02)
parts.append(f'<path d="{en_d}" fill="{INK}"/>')
tag = "Native meeting capture. Live notes. Agent-ready memory."
size = 38
_, adv, _ = SERIF.layout(tag, size, 0, 0)
if adv > W - 176:
    size = size * (W - 176) / adv
tag_d, _, _ = SERIF.layout(tag, size, 88, 520)
parts.append(f'<path d="{tag_d}" fill="{INK}"/>')
foot_d, _, _ = SANS.layout("macOS · local by default · live notes · MCP", 25, 88, 572)
parts.append(f'<path d="{foot_d}" fill="{GRAY}"/>')
put("social/yulu-social-card.svg", svg(W, H, "\n".join(parts), "语录 Yulu 分享卡片",
                                      desc=f"语录 Yulu — {tag} — macOS · local by default · live notes · MCP"))
jobs.append(("social/yulu-social-card.svg", "social/yulu-social-card.png", W, H))
jobs.append(("social/yulu-social-card.svg", "social/yulu-social-card@2x.png", W * 2, H * 2))

# Colors
colors = {
    "light": {"ink": INK, "paper": PAPER, "blue": BLUE, "gray": "#51565b", "gray-2": GRAY, "hairline": "#dbdee2",
              "green": "#248a3d", "amber": "#96590a", "red": "#d70015", "menubar-red": RED},
    "dark": {"ink": INK_DARK, "paper": "#0f1215", "blue": BLUE_DARK, "gray": "#a3a9b0", "gray-2": "#8a9097", "hairline": "#2a2f35",
             "green": "#6bd17a", "amber": "#e0a13c", "red": "#ff6961", "menubar-red": RED_DARK},
}
put("colors/colors.json", json.dumps(colors, ensure_ascii=False, indent=2) + "\n")
css = ["/* 语录 Yulu 颜色。颜色只表达含义：蓝 = 可点 / 正在进行；绿、琥珀、红 = 状态；其余是墨、纸和灰。 */", ":root {"]
css += [f"  --yulu-{k}: {v};" for k, v in colors["light"].items()]
css += ["}", "@media (prefers-color-scheme: dark) {", "  :root {"]
css += [f"    --yulu-{k}: {v};" for k, v in colors["dark"].items()]
css += ["  }", "}", ""]
put("colors/colors.css", "\n".join(css))

(OUT.parent / "raster-jobs.json").write_text(json.dumps(jobs, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"wrote {len(files)} source files, {len(jobs)} raster jobs")
