"""Frozen seed snapshots for the Prompt Library.

These are intentionally frozen copies of the prompts that used to live as
SUMMARY_PROMPT constants in transcribe.py + agent_queue_worker.py and the
inline cleanup prompt in transcribe.py::refine_transcript. The same PR that
adds this module deletes those constants. After that, this file is the
canonical migration history.
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
            "请基于以下会议转录生成最终版结构化会议纪要。\n"
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
            "4. 不要输出解释、寒暄或代码块，只输出纪要正文。\n"
            "\n"
            "会议转录：\n"
            "---\n"
            "{{transcript}}\n"
            "---\n"
        ),
    },
    {
        "slug": "transcript-cleanup",
        "name": "Transcript Cleanup",
        "category": "cleanup",
        "is_auto_run": True,
        "sort_order": 0,
        "content": (
            "请清理以下会议转录，输出 cleaned transcript，不要摘要，不要增删事实。\n"
            "\n"
            "会议主题：{{meeting_title}}\n"
            "\n"
            "要求：\n"
            "- 保留时间戳。\n"
            "- 去除明显重复幻觉句。\n"
            "- 恢复合理标点和段落；口语可轻微整理，但不要改写观点。\n"
            "- 不要输出解释，只输出清理后的 transcript。\n"
            "\n"
            "原始转录：\n"
            "---\n"
            "{{transcript}}\n"
            "---\n"
        ),
    },
    {
        "slug": "action-items",
        "name": "Action Items & Decisions",
        "category": "summary",
        "is_auto_run": False,
        "sort_order": 20,
        "content": (
            "请基于以下会议转录提取 Action Items 与 Decisions。\n"
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
            "\n"
            "会议转录：\n"
            "---\n"
            "{{transcript}}\n"
            "---\n"
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
      - slug in repo with source=SEED but drifted content → UPDATE in place
        (preserve id) → counts toward updated
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
            # Only update if content has drifted from snapshot
            if existing.content != spec["content"]:
                repo.edit(spec["slug"], content=spec["content"])
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
