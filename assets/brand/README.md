# 语录 Yulu 视觉素材包 v1

标志：一笔。开头三个起伏一个比一个低，是说出来的话；顺势平平地落成一条直线，是写下来的记录；末端隔开的一小段蓝色，是此刻正在写下的这一句。

先看 `preview.png`，一张图里有全部内容。

## 目录

| 文件夹 | 内容 |
|---|---|
| `logo/` | 标志本身。`yulu-mark.svg` 浅色背景用，`-on-dark` 深色背景用，`-black` / `-white` 单色。`-32px`、`-16px` 是按像素重画的小尺寸母版。PNG 为透明底，1x / 2x / 4x。 |
| `lockup/` | 标志 + 字标。`yulu-lockup` 是「标志 语录 Yulu」，`yulu-lockup-en` 是「标志 Yulu」，各有深色版。文字已转成路径，不依赖字体。 |
| `app-icon/` | macOS App 图标：默认、深色、单色三种 1024 px，以及各尺寸 PNG。全套尺寸在仓库的 `assets/Yulu.iconset`，打包用的是 `assets/Yulu.icns`。16 / 32 px 用的是简化的小尺寸画法。 |
| `menubar/` | 菜单栏图标，24 × 16 pt（另有 @2x）。见下面的「菜单栏状态」。 |
| `favicon/` | 网站图标：`favicon.svg`、`favicon.ico`（16 / 32 / 48）、PNG 和 180 px 的 `apple-touch-icon.png`。 |
| `social/` | 分享卡片 1280 × 640（另有 @2x），用于 GitHub、链接预览。 |
| `motion/` | 动效参考，浏览器里打开即可播放：录音时的标志、菜单栏录音中、菜单栏处理中。 |
| `colors/` | 颜色：`colors.css`（CSS 变量，自动跟随深浅色）和 `colors.json`。 |

## 使用规则

- **留白**：标志四周至少留出一个笔画宽的 1.5 倍（宽 144 的标志，四周 ≥ 15）。
- **最小尺寸**：完整标志宽度不小于 64 px；更小时用 `-32px` / `-16px` 母版或菜单栏图标，不要直接缩小大图。
- **背景**：浅色背景用默认版，深色背景用 `-on-dark` 版，照片或复杂背景上用单色白或单色黑。
- **颜色**：标志里只有墨色和那一小段蓝。蓝色在语录里只表示“可点”和“正在进行”。
- **不要**：加渐变、发光、阴影；把整条都改成蓝色；把起伏改成尖峰（会像心电图）；改细笔画、拉伸、旋转或拆开；放进对话气泡。

## 颜色

| 名称 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| 墨 | `#0D1114` | `#ECEFF2` | 文字、标志 |
| 纸 | `#F6F9FC` | `#0F1215` | 底色 |
| 蓝 | `#0F74C5` | `#3A93E6` | 可点、正在记录（唯一的强调色） |
| 灰 | `#51565B` | `#A3A9B0` | 说明文字 |
| 二级灰 | `#646A70` | `#8A9097` | 时间、标签 |
| 发丝线 | `#DBDEE2` | `#2A2F35` | 分隔 |
| 绿 / 琥珀 / 红 | `#248A3D` / `#96590A` / `#D70015` | `#6BD17A` / `#E0A13C` / `#FF6961` | 只用于状态：完成 / 等待 / 录音中、失败 |

## 字体

| 用途 | 字体 |
|---|---|
| 标题、字标 | Fraunces（英文）、思源宋体 Noto Serif SC 或 Songti SC（中文） |
| 界面与正文 | Inter，中文用苹方 |
| 时间、版本号 | Geist Mono |

字标「语录」用 Noto Serif SC Bold，字距 +0.04 em；「Yulu」用 Fraunces SemiBold（光学尺寸 144），字距 −0.02 em。以上字体均为 SIL Open Font License。

## 菜单栏状态

| 状态 | 文件 | 说明 |
|---|---|---|
| 空闲 | `idle-template` | 系统模板图标（黑色 + 透明），由系统自动适配浅色 / 深色菜单栏。静止。 |
| 录音中 | `recording-light-level1…5`、`recording-dark-level1…5` | 光标换成红色实心圆点，常亮不闪。声波按音量在 5 档之间切换（level1 最安静，level5 最大声），约每 0.1 秒更新一次。因为有红色，不能用模板图标，所以分浅色 / 深色两套。 |
| 处理中 | `processing-template-frame1…3` | 光标换成三个点，依次亮起，每帧 0.4 秒，循环。模板图标。 |

系统“减少动态效果”打开时：录音中固定用 level4，处理中固定用 frame2，不播放动画。

## 录音时的标志动效

用于实时笔记面板收起后的图标（参考 `motion/yulu-mark-recording.svg`）：

- 声波：振幅 = 标准形状 × 平滑后的音量，范围 0.25–1.2，每帧变化不超过 12%；直线不动。
- 光标：写入 1.2 秒（减速收尾）→ 停留 1.4 秒 → 擦掉 0.6 秒 → 空白 0.4 秒，循环 3.6 秒。
- 只在真的在录音时播放。

## 在产品里的位置

| 用在哪里 | 文件 |
|---|---|
| App 图标（Yulu.app、提示窗口） | `assets/Yulu.icns`、`assets/Yulu.iconset` |
| 菜单栏三种状态和动效 | 由 `yulu/scripts/status_agent.swift` 按本素材包的几何直接绘制，不再打包图片 |
| 实时笔记面板收起后的图标 | 由 `yulu/scripts/recorder_status.swift` 绘制（App 图标 + 录音动效） |
| 网页界面的浏览器图标 | `yulu/scripts/yulu_ui/web/public/favicon.svg`（跟随浅色 / 深色） |
| README 顶部 | `assets/logo.svg`、`assets/logo-dark.svg` |
| GitHub 分享卡片 | `assets/social-card.png`（仓库设置 → Social preview 里上传） |

## 文件说明

- 所有 SVG 都是纯路径，没有外部字体或图片引用，可直接用于网页、Figma、Sketch、Keynote。
- `Yulu.icns` 由本素材包直接生成；如果需要 macOS 官方工具链的结果，可以在 Mac 上运行 `iconutil -c icns assets/Yulu.iconset`。

## 重新生成

改动标志、颜色或文字后，在仓库根目录运行：

```bash
assets/brand/tools/build.sh
```

它会下载用到的字体子集（只含需要的字）、写出全部 SVG、用 Chromium 渲染 PNG、打包 `Yulu.icns` 和 `favicon.ico`，并把产品用到的副本（上表）一起更新。需要 Python 3（fontTools、Pillow）和带 Chromium 的 Node Playwright。菜单栏和面板图标是代码绘制的，改了几何后要同步改那两个 Swift 文件里的路径。
