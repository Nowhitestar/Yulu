#!/usr/bin/env python3
"""
转录音频并生成会议纪要。

支持两种模式：
1. OpenAI Whisper API（推荐，需 OPENAI_API_KEY）
2. 本地 whisper（需安装 openai-whisper）

依赖：
  pip install openai openai-whisper

配置：
{
  "transcription": {
    "mode": "api",        # "api" 或 "local"
    "api_key_env": "OPENAI_API_KEY",
    "language": "zh",
    "model": "whisper-1"  # API 模式
  },
  "llm": {
    "enabled": false,
    "provider": "openai",
    "model": "gpt-4",
    "api_key_env": "OPENAI_API_KEY"
  }
}

输出：
- <meeting>_transcript.txt  — 原始转录文本
- <meeting>_summary.md     — 结构化会议纪要
"""

import json
import os
import sys
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "meeting-assistant" / "config.json"


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def transcribe_with_api(audio_path, config):
    """使用 OpenAI Whisper API 转录。"""
    try:
        import openai
    except ImportError:
        print("openai package not installed. Run: pip install openai", file=sys.stderr)
        sys.exit(1)

    api_key = os.environ.get(config.get("api_key_env", "OPENAI_API_KEY"))
    if not api_key:
        print("OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    client = openai.OpenAI(api_key=api_key)

    with open(audio_path, "rb") as audio_file:
        transcript = client.audio.transcriptions.create(
            model=config.get("model", "whisper-1"),
            file=audio_file,
            language=config.get("language", "zh"),
            response_format="text",
        )

    return transcript


def transcribe_with_local(audio_path, config):
    """使用本地 whisper 转录。"""
    try:
        import whisper
    except ImportError:
        print("Local whisper not installed. Run: pip install openai-whisper", file=sys.stderr)
        sys.exit(1)

    model = whisper.load_model(config.get("model", "base"))
    result = model.transcribe(audio_path, language=config.get("language", "zh"))
    return result["text"]


def generate_summary_with_llm(transcript, meeting_title, config):
    """使用 LLM 生成结构化会议纪要。"""
    try:
        import openai
    except ImportError:
        return None

    api_key = os.environ.get(config.get("api_key_env", "OPENAI_API_KEY"))
    if not api_key:
        return None

    client = openai.OpenAI(api_key=api_key)
    model = config.get("model", "gpt-4")

    prompt = f"""请将以下会议转录整理成结构化会议纪要。

会议主题：{meeting_title}

要求：
1. 列出会议基本信息（主题、时间）
2. 按议题分类讨论要点，每个议题下列出关键发言和结论
3. 提取所有 Action Items（待办事项），标注负责人和截止日期（如能从内容推断）
4. 提取关键决策结论
5. 使用中文，Markdown 格式输出

会议转录：
{transcript}

请输出：
"""

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "你是一个专业的会议助理，擅长整理会议纪要。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"LLM summary failed: {e}", file=sys.stderr)
        return None


def generate_summary_fallback(transcript, meeting_title):
    """不使用 LLM 时的简单格式化。"""
    lines = [
        f"# 会议纪要：{meeting_title}",
        "",
        f"**时间**: {Path(__file__).stem}",
        "",
        "## 会议转录",
        "",
        transcript,
        "",
        "---",
        "",
        "*注：未配置 LLM，以上为原始转录文本。如需智能摘要，请在 config 中启用 llm.enabled。*",
    ]
    return "\n".join(lines)


def process_audio(audio_path):
    config = load_config()
    trans_config = config.get("transcription", {})
    mode = trans_config.get("mode", "api")
    llm_config = config.get("llm", {})

    audio_path = Path(audio_path)
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    meeting_title = audio_path.stem.rsplit("_", 1)[0].replace("_", " ")
    print(f"🎙️ 正在转录: {audio_path.name}")

    # 1. 转录
    if mode == "api":
        transcript = transcribe_with_api(str(audio_path), trans_config)
    else:
        transcript = transcribe_with_local(str(audio_path), trans_config)

    # 2. 保存转录文本
    transcript_path = audio_path.with_suffix(".transcript.txt")
    with open(transcript_path, "w", encoding="utf-8") as f:
        f.write(transcript)
    print(f"✅ 转录已保存: {transcript_path}")

    # 3. 生成纪要
    print("📝 正在生成纪要...")
    if llm_config.get("enabled", False):
        summary = generate_summary_with_llm(transcript, meeting_title, llm_config)
        if summary is None:
            summary = generate_summary_fallback(transcript, meeting_title)
    else:
        summary = generate_summary_fallback(transcript, meeting_title)

    # 4. 保存纪要
    summary_path = audio_path.with_suffix(".summary.md")
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(summary)
    print(f"✅ 纪要已保存: {summary_path}")

    return str(transcript_path), str(summary_path)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    process_audio(audio_file)
