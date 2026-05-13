#!/usr/bin/env python3
"""Yulu adapter for LBrain HTML artifacts.

Yulu owns extraction from summary/transcript; LBrain owns reusable templates.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

LBRAIN = Path.home() / "Documents/LBrain"
RENDER_DIR = LBRAIN / "System/html-artifacts"
import sys
if str(RENDER_DIR) not in sys.path:
    sys.path.insert(0, str(RENDER_DIR))

from render_artifact import render_template  # type: ignore


def _strip_ts(line: str) -> str:
    return re.sub(r"^\[[^\]]+\]\s*", "", line).strip()


def _clean_line(line: str) -> str:
    line = line.strip()
    line = re.sub(r"^[-*]\s+", "", line)
    line = re.sub(r"^- \[[ xX]\]\s*", "", line)
    return line.strip()


def parse_markdown_summary(summary: str) -> dict[str, Any]:
    sections: dict[str, list[str]] = {}
    current = "Overview"
    sections[current] = []
    for raw in summary.splitlines():
        line = raw.rstrip()
        m = re.match(r"^#{1,3}\s+(.+?)\s*$", line)
        if m:
            current = m.group(1).strip()
            sections.setdefault(current, [])
            continue
        if line.strip():
            sections.setdefault(current, []).append(line.strip())

    def pick(*names: str) -> list[str]:
        for key, lines in sections.items():
            lk = key.lower()
            if any(n.lower() in lk for n in names):
                return [_clean_line(x) for x in lines if _clean_line(x)]
        return []

    return {
        "sections": sections,
        "tldr": pick("tl;dr", "tldr", "summary", "概括", "主要结论"),
        "discussion": pick("discussion", "议题", "讨论", "要点"),
        "actions": pick("action", "待办", "todo"),
        "questions": pick("question", "blocker", "问题", "阻塞"),
        "decisions": pick("decision", "结论", "决策"),
    }


def extract_transcript_topics(transcript: str, max_topics: int = 12) -> list[dict[str, str]]:
    topic_keywords = [
        "北极", "指标", "用户", "付费", "revenue", "增长", "SEO", "渠道", "KOL", "GitHub",
        "sponsor", "社群", "小红书", "meetup", "后台", "权限", "API", "充值", "use case",
        "决定", "结论", "下周", "明天", "PR", "产品", "方案",
    ]
    buckets: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw in transcript.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"^\[([^\]]+)\]\s*(.*)$", line)
        ts = m.group(1) if m else ""
        text = (m.group(2) if m else line).strip()
        if not text:
            continue
        is_signal = any(k.lower() in text.lower() for k in topic_keywords)
        if current is None or (is_signal and len(current["lines"]) >= 6):
            current = {"time": ts, "lines": []}
            buckets.append(current)
        current["lines"].append(text)

    topics = []
    for b in buckets:
        joined = " ".join(b["lines"])
        compact = re.sub(r"\s+", "", joined)
        if len(compact) > 80 and len(set(compact)) <= 4:
            continue
        title = _strip_ts(b["lines"][0])[:34] or "Topic"
        snippet = joined[:360] + ("…" if len(joined) > 360 else "")
        topics.append({"time": b["time"], "title": title, "snippet": snippet})
        if len(topics) >= max_topics:
            break
    return topics


def build_artifact_data(title: str, summary: str, transcript: str, paths: dict[str, str] | None = None) -> dict[str, Any]:
    parsed = parse_markdown_summary(summary)
    return {
        "type": "meeting_summary",
        "version": 1,
        "title": title,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "paths": paths or {},
        "tldr": parsed["tldr"],
        "discussion": parsed["discussion"],
        "action_items": parsed["actions"],
        "open_questions": parsed["questions"],
        "decisions": parsed["decisions"],
        "topics": extract_transcript_topics(transcript),
    }


def render_meeting_summary_html(title: str, summary: str, transcript: str, paths: dict[str, str] | None = None) -> str:
    data = build_artifact_data(title, summary, transcript, paths)
    return render_template("meeting-summary.html", data, markdown=summary, raw=transcript)


def write_meeting_summary_html(summary_path: str | Path, transcript_path: str | Path, out_path: str | Path | None = None, title: str | None = None) -> Path:
    summary_path = Path(summary_path)
    transcript_path = Path(transcript_path)
    summary = summary_path.read_text(encoding="utf-8")
    transcript = transcript_path.read_text(encoding="utf-8") if transcript_path.exists() else ""
    title = title or summary_path.stem.replace(".summary", "").replace("_", " ")
    out = Path(out_path) if out_path else summary_path.with_suffix(".html")
    html_text = render_meeting_summary_html(
        title,
        summary,
        transcript,
        paths={"summary": str(summary_path), "transcript": str(transcript_path), "html": str(out)},
    )
    out.write_text(html_text, encoding="utf-8")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate Yulu meeting-summary HTML artifact")
    ap.add_argument("summary")
    ap.add_argument("transcript")
    ap.add_argument("--out")
    ap.add_argument("--title")
    args = ap.parse_args()
    out = write_meeting_summary_html(args.summary, args.transcript, args.out, args.title)
    print(out)


if __name__ == "__main__":
    main()
