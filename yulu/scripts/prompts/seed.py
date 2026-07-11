"""Bundled instruction templates for the Prompt Library.

Summary prompts contain instructions and safe metadata placeholders only.
The Host never interpolates raw transcript text into an Agent prompt; Hermes
reads it through the lease-scoped Yulu MCP operation instead.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .db import Category, PromptsRepo, Source


SEED_PROMPTS: list[dict] = [
    {
        "slug": "summary",
        "name": "Standard Summary",
        "category": "summary",
        "is_auto_run": True,
        "sort_order": 10,
        "content": (
            "请基于本任务通过 task-scoped MCP `recording_task_transcript_read` "
            "读取的完整会议转录，生成最终版结构化会议纪要。\n"
            "\n"
            "会议主题：{{meeting_title}}\n"
            "会议日期：{{date}}\n"
            "\n"
            "要求：\n"
            "1. 输出中文 Markdown。\n"
            "2. 包含以下章节：会议基本信息、TL;DR、Discussion Points、"
            "Action Items（含负责人/截止日期）、Open Questions / Blockers、"
            "Decisions Made。\n"
            "3. 按议题分类讨论要点，每个议题下列出关键发言和结论。\n"
            "4. 涉及人名、负责人、说话人时，只使用转录中已有的标签和证据；"
            "不要强行推断身份或负责人。\n"
            "5. 不要输出解释、寒暄或代码块，只输出纪要正文。\n"
        ),
    },
    {
        "slug": "transcript-cleanup",
        "name": "Transcript Cleanup",
        "category": "cleanup",
        "is_auto_run": False,
        "sort_order": 0,
        "content": (
            "请清理以下会议转录，输出 cleaned transcript，不要摘要，不要增删事实。\n"
            "\n"
            "会议主题：{{meeting_title}}\n"
            "说话人候选：{{speaker_list}}\n"
            "\n"
            "要求：\n"
            "- 保留时间戳。\n"
            "- 保留已有说话人标签和参会者姓名，不要把姓名改成近音词。\n"
            "- 去除明显重复幻觉句。\n"
            "- 恢复合理标点和段落；口语可轻微整理，但不要改写观点。\n"
            "- 不要输出解释，只输出清理后的 transcript。\n"
            "\n"
            "原始转录：\n"
            "---\n"
            "{{best_transcript}}\n"
            "---\n"
        ),
    },
    {
        "slug": "dictation-cleanup",
        "name": "Dictation Cleanup",
        "category": "voice",
        "is_auto_run": False,
        "sort_order": 5,
        "content": (
            "语音输入模式。输出可直接粘贴到当前光标处的正文："
            "保留原意，补齐必要标点，去掉口头停顿词，不要摘要，"
            "不要解释，不要寒暄。保留已经识别出的词，尤其是名称、数字、"
            "术语和近音词；不要擅自改成另一个近音词。优先使用术语表里的专有名词写法。"
        ),
    },
    {
        "slug": "dictation-translate",
        "name": "Dictation Translate",
        "category": "voice",
        "is_auto_run": False,
        "sort_order": 6,
        "content": (
            "语音翻译输入模式。将语音内容翻译成{{target_language}}，"
            "输出可直接粘贴到当前光标处的正文。保留原意和语气，"
            "补齐必要标点，不要摘要，不要解释，不要寒暄。"
            "优先使用术语表里的专有名词写法。"
        ),
    },
    {
        "slug": "action-items",
        "name": "Action Items & Decisions",
        "category": "summary",
        "is_auto_run": False,
        "sort_order": 20,
        "content": (
            "请基于本任务通过 task-scoped MCP `recording_task_transcript_read` "
            "读取的完整会议转录，提取 Action Items 与 Decisions。\n"
            "\n"
            "会议主题：{{meeting_title}}\n"
            "会议日期：{{date}}\n"
            "\n"
            "要求：\n"
            "1. 输出中文 Markdown。\n"
            "2. 只输出两个章节：\n"
            "   - `## Action Items` —— 每条一行 "
            "`- [ ] <内容> (负责人: <人>; 截止: <日期>)`；"
            "负责人/截止可从内容推断，不能强行编造。\n"
            "   - `## Decisions` —— 每条一行 `- <决定> (背景: <一句>)`\n"
            "3. 不输出讨论摘要、TL;DR 等其它内容。\n"
            "4. 如果转录中没有明确的 action 或 decision，对应章节写 `- 无`。\n"
        ),
    },
    {
        "slug": "action-items-by-speaker",
        "name": "Action Items by Speaker",
        "category": "summary",
        "is_auto_run": False,
        "sort_order": 30,
        "content": (
            "请基于本任务通过 task-scoped MCP `recording_task_transcript_read` "
            "读取的完整会议转录，按发言人输出 Action Items。\n"
            "\n"
            "会议主题：{{meeting_title}}\n"
            "会议日期：{{date}}\n"
            "\n"
            "要求：\n"
            "- 仅在转录明确包含 mic/sys 或说话人标签时按双方归属；"
            "无法确认归属时不要猜测。\n"
            "- 输出中文 Markdown，包含两个章节：`## 我承诺的事` / `## 对方承诺的事`。\n"
            "- 每条 Action Item 一行 `- [ ] <内容> (截止: <日期>)`；"
            "截止日期仅在对话中明确提到时填写，否则写 `截止: 未指定`。\n"
            "- 不要输出未明确承诺的「可能要做」的事；如果一方没有任何承诺，对应章节写 `- 无`。\n"
            "- 不输出讨论摘要、TL;DR 等其它内容。\n"
        ),
    },
]


def _now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def seed_from_current(repo: PromptsRepo) -> dict[str, int]:
    """Apply SEED_PROMPTS into the repo.

    Returns {inserted: N, updated: N}. Idempotent:
      - slug not in repo → INSERT with source=SEED → counts toward inserted
      - slug in repo with source=SEED and identical content → skip (no count)
      - slug in repo with source=SEED but drifted seed-owned fields → UPDATE
        in place (preserve id) → counts toward updated
      - slug in repo with source=MANUAL → leave alone entirely (no count)

    After insert/update, writes meta.seeded_at = _now_iso().
    """
    inserted = 0
    updated = 0

    for spec in SEED_PROMPTS:
        existing = repo.by_slug(spec["slug"])
        if existing is None:
            repo.add(
                slug=spec["slug"],
                name=spec["name"],
                category=Category(spec["category"]),
                content=spec["content"],
                is_auto_run=spec["is_auto_run"],
                source=Source.SEED,
                sort_order=spec["sort_order"],
            )
            inserted += 1
        elif existing.source == Source.SEED:
            if (
                existing.name != spec["name"]
                or existing.category.value != spec["category"]
                or existing.content != spec["content"]
                or existing.is_auto_run != spec["is_auto_run"]
                or existing.sort_order != spec["sort_order"]
            ):
                repo.edit(
                    spec["slug"],
                    name=spec["name"],
                    category=Category(spec["category"]),
                    content=spec["content"],
                    is_auto_run=spec["is_auto_run"],
                    sort_order=spec["sort_order"],
                )
                updated += 1
            # else: identical — skip, no count
        # else: source=MANUAL or LEARNED — leave alone

    repo.set_meta("seeded_at", _now_iso())
    return {"inserted": inserted, "updated": updated}


def restore_defaults(repo: PromptsRepo) -> dict[str, int]:
    """Force seed rows back to bundled snapshot values.

    Same in-place semantics as vocab/seed.py::restore_defaults:
      - For each slug in SEED_PROMPTS: if a seed-source row exists, revert
        its fields to the bundled values (id preserved); else INSERT a new
        seed row.
      - Rows with source=MANUAL or source=LEARNED are NEVER touched.

    Returns same {inserted, updated} shape.
    """
    inserted = 0
    updated = 0

    for spec in SEED_PROMPTS:
        existing = repo.by_slug(spec["slug"])
        if existing is None:
            # No row at all — insert fresh seed row
            repo.add(
                slug=spec["slug"],
                name=spec["name"],
                category=Category(spec["category"]),
                content=spec["content"],
                is_auto_run=spec["is_auto_run"],
                source=Source.SEED,
                sort_order=spec["sort_order"],
            )
            inserted += 1
        elif existing.source == Source.SEED:
            # Revert in place regardless of current content
            repo.edit(
                spec["slug"],
                name=spec["name"],
                content=spec["content"],
                category=Category(spec["category"]),
                is_auto_run=spec["is_auto_run"],
                sort_order=spec["sort_order"],
            )
            updated += 1
        # else: source=MANUAL or LEARNED — leave alone

    repo.set_meta("seeded_at", _now_iso())
    return {"inserted": inserted, "updated": updated}
