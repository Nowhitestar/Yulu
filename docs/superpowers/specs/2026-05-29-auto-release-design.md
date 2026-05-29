# 自动发版设计 — Conventional Commits + release-please

**日期**：2026-05-29
**状态**：已批准，落地中

## 目标

把发版从"人工记得 + 手动打 tag"变成"零判断、规则驱动、由 Lewis 挑时机一键发布"。Lewis 只需正常迭代「语录」（Yulu），用规范前缀写 commit；发版的版本号、CHANGELOG、tag、打包、上传全部自动。

## 原则（来自 Lewis）

1. **零人工判断版本号** —— 版本号由 commit 类型自动算，不手填。
2. **fix 也计入发版**，但**攒一批再发**，不是每个 fix 立即发 patch。
3. **不频繁** —— 发版时机由 Lewis 控制。

## 方案：release-please（累积式自动发版）

`release-please` 精确匹配上述原则：

- **平时**：`feat:` / `fix:` commit 合入 `main` → release-please 自动维护一个 **Release PR**，实时累积 changelog + 按 Conventional Commits 算好的下一个版本号。
- **发版**：Lewis 攒够了 → 合并那个 Release PR。**唯一动作**，且只是决定**时机**（版本号/changelog 都已自动算好）。
- **合并后全自动**：bump `VERSION` → 更新 `CHANGELOG.md` → 打 tag → 打包 → 上传 release asset。

### Conventional Commits → 版本号映射

| 前缀 | 含义 | 版本影响 |
|---|---|---|
| `feat:` | 新功能 | minor ↑ |
| `fix:` | bug 修复 | patch ↑ |
| `feat!:` / footer `BREAKING CHANGE:` | 破坏性 | major ↑ |
| `chore: / docs: / refactor: / test: / ci: / style: / build:` | 杂项 | 不发版 |

一个 Release PR 里若同时有 feat 和 fix，取最高级别（feat → minor）。

## 架构

四个改动 + 两个配置文件：

### 1. `release-please-config.json`（新）
```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": { "release-type": "simple", "version-file": "VERSION", "changelog-path": "CHANGELOG.md" }
  }
}
```
`release-type: simple` + `version-file: VERSION` → release-please 直接维护根 `VERSION` 文件（Yulu 的版本真相源）。

### 2. `.release-please-manifest.json`（新）
```json
{ ".": "0.5.0" }
```
起点 = 当前已发布的最新版本。

### 3. `.github/workflows/release-publish.yml`（新，reusable）
把现有 `release.yml` 的「校验 tag==VERSION → 跑测试 → `make package` → 创建/更新 Release + 上传 asset」逻辑抽成 `workflow_call` 可复用工作流（输入 `tag`）。两条发版路径共用，避免重复。

### 4. `.github/workflows/release.yml`（改）
保留为**手动打 tag 的逃生通道**（紧急 hotfix）。改为只 `uses: ./.github/workflows/release-publish.yml`，传 `github.ref_name`。

### 5. `.github/workflows/release-please.yml`（新，自动主路径）
```
on: push: branches: [main]
job release-please: googleapis/release-please-action@v4 → 输出 release_created / tag_name
job publish: needs release-please, if release_created → uses release-publish.yml (tag_name)
```

### 6. `.github/workflows/pr-title-lint.yml`（新）
用 `amannn/action-semantic-pull-request` 校验 PR 标题符合 Conventional Commits（配合 **squash merge**：PR 标题即落入 `main` 的 commit message，release-please 据此判断）。不合规则 PR 检查失败并提示。

## 绕开的关键坑：GITHUB_TOKEN 不触发下游 workflow

GitHub Actions 默认 `GITHUB_TOKEN` push 的 tag **不会**触发独立 workflow。若让 release-please 打 tag 去触发 `release.yml` 会静默失效。

**解法**：不靠 tag 跨 workflow 触发，而是在 release-please **同一个 workflow 里**用 `needs` + `if: release_created` 直接 call `release-publish.yml`。全程 `GITHUB_TOKEN` 足够，**不需要 PAT**（避免 PAT 过期导致自动发版哪天静默失效）。

## 数据流

```
日常: feat/fix commit (squash, 规范标题) → main
        ↓ (release-please.yml on push main)
release-please 自动开/更新 Release PR (累积 changelog + 算版本号)
        ↓ (Lewis 攒够了, 合并 Release PR)
release-please-action: bump VERSION + 更新 CHANGELOG + 打 tag vX.Y.Z + 建 GitHub Release(带 notes)
        ↓ (同 workflow, if release_created)
release-publish.yml: 跑测试 → make package → gh release upload (zip + checksums + install.sh)
        ↓
用户 install.sh / yulu update 拉到新版本
```

## 首次启用行为

1. 本 PR（`feat/auto-release`）合并到 `main` → release-please 开始工作，manifest 起点 `0.5.0`。
2. 它扫描自 `v0.5.0` tag 以来的 commits。本分支自身的 commit 是 `ci:` 类（不发版）。
3. 待 bug-fix PR #31（`fix: restore exec bits…`）合并到 `main`，release-please 看到该 `fix:` → 自动开 `0.5.1` 的 Release PR。Lewis 合并它即发布 v0.5.1。

## CHANGELOG 迁移

现有 `CHANGELOG.md` 是手写 Keep a Changelog 格式。release-please 在 `# Changelog` 标题下方插入它生成的 `## [x.y.z]` 段，**保留下方历史段不动**。`release.yml` 的 release-notes 提取按 `## [version]` 匹配，与 release-please 生成的段格式一致。手写的 `## [Unreleased]` 段以后不再手动维护（由 commit 驱动），可留空或移除。

## 约束

- **必须用 squash merge**，且 PR 标题符合 Conventional Commits（`pr-title-lint.yml` 把关）。这是"零判断"的代价：判断前移到"写 commit/PR 标题时选前缀"。
- 贡献者需了解前缀规范（写进 CONTRIBUTING / PR 模板，非本 spec 范围）。

## 验证

- YAML 语法（actionlint 或 `python -c yaml.safe_load`）。
- JSON 有效性（config + manifest）。
- `release-publish.yml` 重构后与原 `release.yml` 行为等价（逐步对照）。
- 端到端：合并本 PR 后观察 release-please 是否开 PR；合并 #31 后是否提议 0.5.1。
