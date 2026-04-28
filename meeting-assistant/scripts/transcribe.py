#!/usr/bin/env python3
"""
转录音频并生成会议纪要。

支持两种模式：
1. OpenAI Whisper API（推荐，需 OPENAI_API_KEY）
2. 本地 whisper（需安装 openai-whisper，质量更好但较慢）

配置：
{
  "transcription": {
    "mode": "api",  # "api" 或 "local"
    "api_key_env": "OPENAI_API_KEY",
    "language": "zh",
    "model": "whisper-1"  # API 模式
  }
}

输出：
- 原始转录文本: <meeting>_transcript.txt
- 会议纪要: <meeting>_summary.md
"""

import json
import os
import subprocess
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
    import openai

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


def generate_summary(transcript, config):
    """使用 LLM 生成会议纪要。"""
    # 这里可以调用 OpenAI API 或其他 LLM
    # 作为技能，先提供一个简单框架
    summary_prompt = f"""请将以下会议转录整理成结构化会议纪要：

要求：
1. 列出会议主题、时间、参与人（如能从内容推断）
2. 按议题分类讨论要点
3. 提取所有 Action Items（待办事项），标注负责人和截止日期
4. 提取关键决策结论
5. 使用中文输出

会议转录：
{transcript}

请输出 Markdown 格式纪要。
"""

    # 如果配置了 LLM API，则调用
    llm_config = config.get("llm", {})
    if llm_config.get("enabled", False):
        # TODO: 实现 LLM 调用
        pass

    # 默认返回转录文本，让用户后续手动总结或配置 LLM
    return summary_prompt


def process_audio(audio_path):
    config = load_config()
    trans_config = config.get("transcription", {})
    mode = trans_config.get("mode", "api")

    audio_path = Path(audio_path)
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Transcribing: {audio_path}")

    if mode == "api":
        transcript = transcribe_with_api(str(audio_path), trans_config)
    else:
        transcript = transcribe_with_local(str(audio_path), trans_config)

    # 保存转录文本
    transcript_path = audio_path.with_suffix(".transcript.txt")
    with open(transcript_path, "w", encoding="utf-8") as f:
        f.write(transcript)
    print(f"Transcript saved: {transcript_path}")

    # 生成会议纪要
    summary = generate_summary(transcript, config)
    summary_path = audio_path.with_suffix(".summary.md")
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(summary)
    print(f"Summary saved: {summary_path}")

    return str(transcript_path), str(summary_path)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    process_audio(audio_file)
