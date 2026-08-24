---
phase: 10
slug: provider-model-xai-foundation
status: approved
shadcn_initialized: false
preset: none
created: 2026-08-24
---

# Phase 10 — UI Design Contract

> Extend Yulu's existing settings and Agent Console. No new design system, modal wizard, or component dependency.

## Design System

| Property | Value |
|----------|-------|
| Tool | Existing Yulu CSS and React components; no shadcn |
| Preset | Not applicable |
| Component library | Existing native controls/settings cards |
| Icon library | lucide-react (already installed) |
| Font | Inter body, Fraunces headings, Geist Mono technical labels |
| Theme | Existing `tokens.css` variables across Default/Ayu/Paper/Custom and light/dark modes |

## Information Architecture

### Settings navigation

Expose the existing `llm` category as **AI Providers / 智能服务** at `/settings/llm`, placed after Transcription and before Voice Input. The category contains:

1. **Capability choices** — three independent rows for Transcription, Summary, and Conversation.
2. **xAI connection** — one shared credential card, not three authorization flows.
3. **Readiness** — three capability-specific status rows and test actions.

`/settings/transcription` keeps detailed local/xAI audio-engine controls, but its xAI card becomes a compact connection/readiness projection with a link to AI Providers. Do not duplicate OAuth/API-key forms.

### Conversation surface

Keep conversation in the existing Agent Console. Every conversation header shows the pinned provider and model. xAI answers render the existing local `sources` cards. A paused session keeps its messages visible and disables new sends until the user retries the same provider or starts a new conversation after visiting provider settings.

### Summary failure surface

The existing recording/task status card shows the pinned summary provider/model and a provider-paused callout. It offers:

- **Retry same provider** — retains the snapshot.
- **Open AI Providers** — changes only future work.
- **Keep paused** — default; no request is sent.

## Component Contract

| Component | Reuse/new | Responsibility |
|-----------|-----------|----------------|
| `ProviderSection` | New, small | Independent summary/conversation selectors; transcription projection/link; one xAI connection card; three readiness rows |
| `TranscriptionSection` | Extend | Keep engine/local-model controls; remove duplicate full auth form; link to shared provider setup |
| Settings category list/detail | Extend | Make existing `llm` category visible and map it to `ProviderSection` |
| Agent Console conversation | Extend | Display pinned provider/model, local source cards, paused state/actions |
| Recording job/task surface | Extend | Display pinned summary provider/model and explicit paused actions |

No provider dropdown may write another capability's setting. Provider/model selection is saved immediately through the existing config update pattern; readiness is a separate user-triggered request and never auto-changes the selection.

## State Matrix

| State | xAI connection card | Capability row | Primary action |
|-------|---------------------|----------------|----------------|
| Not connected | “Not connected” muted badge; Grok OAuth and API-key choices | xAI choice may remain selected but readiness is blocked | `Connect with Grok` |
| Authorizing | Device URL/code and cancel; `role=status` | Selectors remain usable; probes disabled | `Cancel` |
| Connected, untested | Credential source label only (Grok OAuth or API key; never token/key) | “Not tested” | `Test` |
| Testing | Stable row height; spinner/text; button disabled | “Testing…” | none |
| Ready | Green badge plus tested model/time | “Ready” | `Test again` |
| Failed | Inline alert states problem and next action | “Needs attention”; selection unchanged | `Test again` / `Reconnect` |
| Task/session paused | Connection state remains factual | Pinned provider/model shown; no fallback | `Retry same provider` |

## Copywriting Contract

| Element | English | Chinese |
|---------|---------|---------|
| Category | AI Providers | 智能服务 |
| Category description | Choose transcription, summary, and conversation independently | 分别选择转写、摘要和对话服务 |
| Shared-card title | xAI connection | xAI 连接 |
| OAuth CTA | Connect with Grok | 使用 Grok 账号连接 |
| OAuth helper | Uses Grok CLI OAuth. Available capabilities depend on your Grok account. | 使用 Grok CLI OAuth；可用能力取决于你的 Grok 账号。 |
| API-key fallback | Use API key instead | 改用 API Key |
| Secret helper | Saved in macOS Keychain. Yulu will not show it again. | 保存在 macOS 钥匙串中，Yulu 不会再次显示。 |
| Probe actions | Test transcription / Test summary / Test conversation | 测试转写 / 测试摘要 / 测试对话 |
| Paused heading | Provider paused | 服务已暂停 |
| Paused body | `{provider} · {model}` failed. Yulu did not switch providers. | `{provider} · {model}` 请求失败，Yulu 没有切换服务。 |
| Retry | Retry same provider | 使用同一服务重试 |
| Settings link | Open AI Providers | 打开智能服务设置 |
| New-session note | Provider changes apply to a new conversation. | 服务变更将在新对话中生效。 |
| Empty xAI sources | No matching local meeting excerpts were found. Nothing was sent to xAI. | 未找到匹配的本地会议片段，本次未向 xAI 发送内容。 |

Errors must name the failed capability, pinned provider/model, and one recovery action. Never say “fallback”, “switched”, or “using another model” unless the user explicitly created new work.

## Spacing Scale

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon gaps, status dot gaps |
| sm | 8px | Inline action gaps |
| compact | 12px | Dense card padding/row gaps |
| md | 16px | Standard card padding |
| lg | 24px | Section gaps |
| xl | 32px | Detail-pane major breaks |

Exceptions: existing settings shell dimensions and border radii remain unchanged; do not normalize unrelated CSS.

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 13px | 400 | 1.5 |
| Helper/status | 11.5px | 400–500 | 1.45 |
| Technical provider/model | 10.5–11px Geist Mono | 500 | 1.35 |
| Card heading | 14px Fraunces | 600 | 1.3 |
| Page heading | 20px Fraunces | 600 | 1.25 |

No new display typography is required.

## Color

| Role | Value | Usage |
|------|-------|-------|
| Dominant | existing wallpaper/surface tokens | Page and cards |
| Secondary | `var(--surface-solid)`, `var(--edge-card)` | Provider/readiness cards |
| Accent | `var(--accent)`, `var(--accent-soft)` | Selected provider, primary connect/test action, focus ring |
| Success | `var(--green)` | Real probe passed only |
| Destructive/error | `var(--red)` | Probe/auth failure and logout/remove credential only |
| Muted | existing `--fg-2`/`--fg-3` tokens | Untested/unavailable helper copy |

Accent is reserved for the active selector, primary action, links, and focus state. A configured-but-untested provider is muted, never green.

## Accessibility and Responsive Behavior

- Provider choices use labeled radio groups or native selects with unique capability labels; never color-only state.
- Status updates use `role=status`; errors use `role=alert`; device authorization code remains selectable text.
- All actions are keyboard reachable, retain existing focus styles, and have at least the current settings-button hit area.
- Secret input uses `type=password`, autocomplete guidance appropriate for an API key, and is cleared immediately after successful submission; it is never pre-filled.
- At narrow widths, capability rows stack label/status above selector/actions; source cards and pause actions wrap without horizontal scrolling.
- Loading does not collapse row height or move neighboring controls.

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not required |
| third-party | none | no install or diff review required |

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS — actions name outcomes; error/empty/recovery copy is explicit in English and Chinese.
- [x] Dimension 2 Visuals: PASS — existing settings and Agent Console patterns are reused; no decorative UI is introduced.
- [x] Dimension 3 Color: PASS — theme tokens only; green requires a real probe; red is limited to failure/removal.
- [x] Dimension 4 Typography: PASS — existing Inter/Fraunces/Geist Mono roles and dense scale are preserved.
- [x] Dimension 5 Spacing: PASS — declared 4px-derived scale, stable loading rows, narrow layout specified.
- [x] Dimension 6 Registry Safety: PASS — no registry block or dependency is added.

**Approval:** approved 2026-08-24
