#!/usr/bin/env python3
"""Agent-owned voice input coordinated by Yulu's native capture layer."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from datetime import date, datetime
from pathlib import Path
from typing import Any


def _resolve_runtime_dir() -> Path:
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return MacOSPathResolver().runtime_dir()
    except Exception:
        return Path.home() / ".config" / "yulu"


CONFIG_DIR = _resolve_runtime_dir()
CONFIG_PATH = CONFIG_DIR / "config.json"
AUDIO_SOCKET = CONFIG_DIR / "audio_daemon.sock"
STATUS_AGENT_SOCKET = CONFIG_DIR / "status_agent.sock"
MCP_TOKEN_PATH = CONFIG_DIR / "mcp-token.json"
PROMPTS_DB = CONFIG_DIR / "prompts.sqlite"
VOCAB_DB = CONFIG_DIR / "vocab.sqlite"
DICTATION_DIR = CONFIG_DIR / "dictation"
STATE_PATH = DICTATION_DIR / "state.json"
HISTORY_PATH = DICTATION_DIR / "history.jsonl"
LEGACY_REALTIME_PID_PATH = DICTATION_DIR / "realtime.pid"
DEFAULT_PROMPT_SLUG = "dictation-cleanup"
DEFAULT_TRANSLATE_PROMPT_SLUG = "dictation-translate"
DEFAULT_UI_BASE_URL = "http://127.0.0.1:7777"
DEFAULT_CONTEXT_LIMIT = 240
DEFAULT_HERMES_TIMEOUT_SEC = 30.0
DEFAULT_HERMES_DEADLINE_SEC = 30.0
DEFAULT_HERMES_TRANSLATE_TIMEOUT_SEC = 30.0
DEFAULT_HERMES_TRANSLATE_DEADLINE_SEC = 30.0
LEGACY_REALTIME_STOP_WAIT_SEC = 4.0
REALTIME_START_TIMEOUT_SEC = 5.0
REALTIME_STOP_TIMEOUT_SEC = 3.0
FFMPEG_FALLBACKS = (
    Path("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"),
    Path("/opt/homebrew/bin/ffmpeg"),
    Path("/usr/local/bin/ffmpeg"),
    Path("/usr/bin/ffmpeg"),
)
MANUAL_SILENCE_SECONDS = 3600.0
DEADLINE_RESERVE_SEC = 0.0
MIN_STT_TIMEOUT_SEC = 0.2
CLIPBOARD_RESERVE_SEC = 0.5
PASTE_RESERVE_SEC = 0.8
CJK_CHAR_RE = r"\u3400-\u4dbf\u4e00-\u9fff"
CJK_PUNCT_RE = "，。！？、；：,.!?;:"


class DictationError(RuntimeError):
    pass


class DictationNoSpeechError(DictationError):
    pass


class DictationPasteError(DictationError):
    pass


def dictation_error_payload(exc: Exception, *, audio_path: str = "") -> dict[str, Any]:
    if isinstance(exc, DictationNoSpeechError):
        code = "no_speech"
    elif isinstance(exc, DictationPasteError):
        code = "paste_failed"
    else:
        code = "transcription_failed"
    payload: dict[str, Any] = {
        "ok": False,
        "error_code": code,
        "message": str(exc),
    }
    if audio_path:
        payload["audio_path"] = audio_path
        payload["audio_preserved"] = Path(audio_path).exists()
    if code == "paste_failed":
        payload["copied"] = True
    return payload


def _load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_history(result: dict[str, Any], *, history_path: Path | None = None) -> None:
    text = str(result.get("text") or "").strip()
    if not text:
        return
    history_path = history_path or HISTORY_PATH
    created_at = _now()
    target_language = str(result.get("target_language") or "").strip()
    item = {
        "id": f"{created_at}-{Path(str(result.get('audio_path') or 'dictation')).stem}",
        "created_at": created_at,
        "action": "translate" if target_language else "dictate",
        "text": text,
        "audio_path": str(result.get("audio_path") or ""),
        "engine": str(result.get("engine") or ""),
        "language": str(result.get("language") or ""),
        "prompt_slug": str(result.get("prompt_slug") or ""),
        "target_language": target_language,
        "copied": bool(result.get("copied")),
        "pasted": bool(result.get("pasted")),
    }
    history_path.parent.mkdir(parents=True, exist_ok=True)
    with history_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")


def _socket_send(socket_path: Path, payload: dict[str, Any], *, timeout: float = 5.0) -> dict[str, Any]:
    if not socket_path.exists():
        raise DictationError(f"socket not found: {socket_path}")
    sock = None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect(str(socket_path))
        sock.sendall(json.dumps(payload).encode())
        sock.shutdown(socket.SHUT_WR)
        data = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
    except OSError as exc:
        raise DictationError(f"socket error: {exc}") from exc
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass
    if not data:
        raise DictationError("empty daemon response")
    return json.loads(data.decode())


def _config() -> dict[str, Any]:
    return _load_json(CONFIG_PATH)


def _host_agent_request(path: str, payload: dict[str, Any], *, timeout_sec: float) -> dict[str, Any]:
    token_doc = _load_json(MCP_TOKEN_PATH)
    token = str(token_doc.get("token") or "").strip()
    if not token:
        raise DictationError("Yulu Host token is unavailable")
    base_url = os.environ.get("YULU_UI_BASE_URL", "").strip()
    if not base_url:
        base_url = f"http://127.0.0.1:{os.environ.get('YULU_UI_PORT', '7777')}"
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=max(0.2, timeout_sec)) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail = str(json.loads(body).get("detail") or "")
        except (json.JSONDecodeError, AttributeError):
            detail = ""
        if "empty transcript" in detail.lower():
            raise DictationNoSpeechError(detail) from exc
        raise DictationError(f"Yulu transcription failed: HTTP {exc.code} {body}") from exc
    except OSError as exc:
        raise DictationError(f"Yulu transcription unavailable: {exc}") from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        detail = result.get("detail") if isinstance(result, dict) else "invalid Host response"
        raise DictationError(f"Yulu transcription failed: {detail}")
    return result


def start_realtime_dictation(state: dict[str, Any]) -> None:
    if state.get("intent") != "dictation" or state.get("target_language"):
        return
    try:
        _host_agent_request(
            "/api/recordings/realtime/start",
            {
                "audioPath": state["audio_path"],
                "title": "Dictation",
                "language": state["language"],
                "replaceActive": False,
            },
            timeout_sec=REALTIME_START_TIMEOUT_SEC,
        )
        state["realtime_started"] = True
    except DictationError as exc:
        state["realtime_started"] = False
        state["realtime_error"] = str(exc)


def stop_realtime_dictation(state: dict[str, Any], *, timeout_sec: float = REALTIME_STOP_TIMEOUT_SEC) -> None:
    if not state.get("realtime_started"):
        return
    started = time.monotonic()
    try:
        payload = _host_agent_request(
            "/api/recordings/realtime/stop",
            {"audioPath": state["audio_path"]},
            timeout_sec=timeout_sec,
        )
        result = payload.get("result")
        if (
            isinstance(result, dict)
            and result.get("status") == "finished"
            and result.get("trusted") is True
            and str(result.get("stableText") or "").strip()
        ):
            state["realtime_result"] = result
        else:
            reason = result.get("reason") if isinstance(result, dict) else "realtime session unavailable"
            state["realtime_error"] = str(reason or "untrusted realtime transcript")
    except DictationError as exc:
        state["realtime_error"] = str(exc)
    finally:
        state["realtime_stop_ms"] = int((time.monotonic() - started) * 1000)


def wait_for_realtime_start(state: dict[str, Any]) -> dict[str, Any]:
    deadline = time.monotonic() + REALTIME_START_TIMEOUT_SEC + 0.25
    while state.get("realtime_starting") and time.monotonic() < deadline:
        time.sleep(0.02)
        latest = _state()
        if latest.get("audio_path") != state.get("audio_path"):
            break
        state = latest
    return state


def _dictation_config(config: dict[str, Any]) -> dict[str, Any]:
    trans = config.get("transcription", {})
    if not isinstance(trans, dict):
        return {}
    item = trans.get("dictation", {})
    return item if isinstance(item, dict) else {}


def resolve_engine(config: dict[str, Any], requested: str | None) -> str:
    trans = config.get("transcription", {})
    trans = trans if isinstance(trans, dict) else {}
    engine = str(trans.get("engine") or "local").strip().lower()
    return engine if engine in {"local", "xai"} else "local"


def resolve_translation_engine(config: dict[str, Any], requested: str | None, target_language: str) -> str:
    return resolve_engine(config, requested)


def resolve_language(config: dict[str, Any], requested: str | None) -> str:
    if requested:
        return requested
    trans = config.get("transcription", {})
    trans = trans if isinstance(trans, dict) else {}
    return str(_dictation_config(config).get("language") or trans.get("language") or "zh")


def _seed_prompt(slug: str) -> str:
    try:
        from prompts.seed import SEED_PROMPTS
    except Exception:
        return ""
    for spec in SEED_PROMPTS:
        if spec.get("slug") == slug:
            return str(spec.get("content") or "")
    return ""


def render_context_prompt(
    *,
    prompt_slug: str | None,
    prompt_id: str | None = None,
    prompts_db: Path = PROMPTS_DB,
    limit: int = 800,
    target_language: str = "",
) -> str:
    if prompt_slug == "none":
        return ""
    slug = prompt_slug or DEFAULT_PROMPT_SLUG
    content = ""
    if prompts_db.exists():
        from prompts.cache import PromptsCache

        cache = PromptsCache(prompts_db)
        cache.load()
        prompt = cache.by_id(prompt_id) if prompt_id else cache.by_slug(slug)
        if prompt is not None:
            content = cache.render(
                prompt,
                transcript="",
                meeting_title="Dictation",
                date=date.today().isoformat(),
            )
    if not content and not prompt_id:
        content = _seed_prompt(slug)
    if not content:
        raise DictationError(f"prompt not found: {prompt_id or slug}")
    content = content.replace("{{target_language}}", target_language or "English")
    return content[:limit].strip() if limit > 0 else content.strip()


def glossary_hint(*, vocab_db: Path = VOCAB_DB, limit: int = 400) -> str:
    if limit <= 0 or not vocab_db.exists():
        return ""
    try:
        from vocab import Scope, VocabRepo, open_db

        conn = open_db(vocab_db)
        try:
            words = VocabRepo(conn).list_words(scopes=[Scope.PROMPT, Scope.BOTH], enabled_only=True)
        finally:
            conn.close()
    except Exception:
        return ""
    items: list[str] = []
    size = 0
    for word in words:
        item = word.term if word.term == word.canonical else f"{word.term} => {word.canonical}"
        if size + len(item) + 1 > limit:
            break
        items.append(item)
        size += len(item) + 1
    return "常见术语：" + "；".join(items) if items else ""


def _state() -> dict[str, Any]:
    return _load_json(STATE_PATH)


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _is_dictation_audio_path(value: Any) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    try:
        path = Path(text).expanduser().resolve(strict=False)
        base = DICTATION_DIR.expanduser().resolve(strict=False)
        return path == base or base in path.parents
    except Exception:
        return text.startswith(str(DICTATION_DIR))


def cleanup_legacy_realtime_sidecar(*, wait: bool = True) -> None:
    """Stop a stale pre-Agent-native sidecar left by an older installation."""
    if not LEGACY_REALTIME_PID_PATH.exists():
        return
    try:
        pid = int(LEGACY_REALTIME_PID_PATH.read_text(encoding="utf-8").strip())
    except Exception:
        LEGACY_REALTIME_PID_PATH.unlink(missing_ok=True)
        return

    def alive() -> bool:
        try:
            waited, _status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                return False
        except ChildProcessError:
            pass
        except Exception:
            pass
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except Exception:
            return False

    try:
        if alive():
            try:
                os.killpg(pid, signal.SIGTERM)
            except Exception:
                os.kill(pid, signal.SIGTERM)
            if wait:
                deadline = time.time() + LEGACY_REALTIME_STOP_WAIT_SEC
                while time.time() < deadline and alive():
                    time.sleep(0.1)
                if alive():
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except Exception:
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except Exception:
                            pass
    except Exception:
        pass
    LEGACY_REALTIME_PID_PATH.unlink(missing_ok=True)


def start_recording(
    *,
    engine: str,
    language: str,
    prompt_slug: str,
    prompt_id: str | None,
    target_language: str,
    silence_seconds: float,
    capture_target: bool = True,
    intent: str = "dictation",
    target_bundle_id: str = "",
    target_app_name: str = "",
) -> dict[str, Any]:
    status = _socket_send(AUDIO_SOCKET, {"action": "status"}, timeout=2)
    if status.get("recording"):
        raise DictationError(f"audio_daemon already recording: {status.get('file') or '<unknown>'}")
    DICTATION_DIR.mkdir(parents=True, exist_ok=True)
    resp = _socket_send(
        AUDIO_SOCKET,
        {
            "action": "start",
            "title": "Dictation",
            "sys_disabled": True,
            "output_dir": str(DICTATION_DIR),
            "silence_seconds": silence_seconds,
        },
        timeout=8,
    )
    if resp.get("status") != "recording" or not resp.get("file"):
        raise DictationError(f"dictation start failed: {resp}")
    state = {
        "audio_path": resp["file"],
        "engine": engine,
        "language": language,
        "prompt_slug": prompt_slug,
        "prompt_id": prompt_id,
        "target_language": target_language,
        "intent": intent,
        "started_at": _now(),
        "realtime_starting": True,
    }
    if capture_target:
        if target_bundle_id or target_app_name:
            state.update({
                "target_bundle_id": target_bundle_id,
                "target_app_name": target_app_name,
            })
        else:
            try:
                state.update(current_frontmost_app())
            except Exception:
                pass
    # Persist the capture identity before realtime startup can block. The native
    # overlay may observe audio_daemon recording immediately, and a fast second
    # hotkey must stop this session instead of attempting another start.
    _write_json(STATE_PATH, state)
    try:
        start_realtime_dictation(state)
    finally:
        state["realtime_starting"] = False
        _write_json(STATE_PATH, state)
    return state


def stop_recording() -> dict[str, Any]:
    state = _state()
    if not state.get("audio_path"):
        raise DictationError("no active dictation state")
    status = _socket_send(AUDIO_SOCKET, {"action": "status"}, timeout=2)
    if not status.get("recording"):
        state = wait_for_realtime_start(state)
        stop_realtime_dictation(state)
        raise DictationError("audio_daemon is not recording")
    if status.get("file") and status.get("file") != state.get("audio_path"):
        stop_realtime_dictation(state)
        raise DictationError(f"active recording is not this dictation: {status.get('file')}")
    resp = _socket_send(AUDIO_SOCKET, {"action": "stop"}, timeout=8)
    if resp.get("status") != "stopped" or not resp.get("file"):
        raise DictationError(f"dictation stop failed: {resp}")
    cleanup_legacy_realtime_sidecar(wait=True)
    state["audio_path"] = resp["file"]
    state["recording_duration_sec"] = resp.get("duration", 0)
    state["stopped_at"] = _now()
    state = wait_for_realtime_start(state)
    stop_realtime_dictation(state)
    return state


def cancel_recording() -> dict[str, Any]:
    state = _state()
    audio_path = str(state.get("audio_path") or "")
    stopped = False
    status_error = ""
    resp: dict[str, Any] = {}
    try:
        status = _socket_send(AUDIO_SOCKET, {"action": "status"}, timeout=2)
    except Exception as exc:
        status = {}
        status_error = str(exc)

    active_file = str(status.get("file") or "")
    if status.get("recording"):
        if not _is_dictation_audio_path(active_file):
            raise DictationError(f"active recording is not dictation: {active_file or '<unknown>'}")
        resp = _socket_send(AUDIO_SOCKET, {"action": "stop"}, timeout=8)
        if resp.get("status") != "stopped":
            raise DictationError(f"dictation cancel failed: {resp}")
        stopped = True
        audio_path = str(resp.get("file") or active_file or audio_path)

    cleanup_legacy_realtime_sidecar(wait=False)
    state = wait_for_realtime_start(state)
    stop_realtime_dictation(state, timeout_sec=1.0)
    result = {
        "text": "",
        "action": "cancel",
        "canceled": True,
        "stopped_recording": stopped,
        "audio_path": audio_path,
        "recording_duration_sec": resp.get("duration", 0),
        "updated_at": _now(),
    }
    if status_error:
        result["audio_status_error"] = status_error
    _write_json(STATE_PATH, {"last_result": result, "updated_at": _now()})
    return result


def active_dictation_state() -> dict[str, Any] | None:
    state = _state()
    audio_path = state.get("audio_path")
    if not audio_path:
        return None
    status = _socket_send(AUDIO_SOCKET, {"action": "status"}, timeout=2)
    if status.get("recording") and status.get("file") == audio_path:
        return state
    return None


def extract_response_text(response: dict[str, Any]) -> str:
    channels = response.get("channels")
    if isinstance(channels, dict):
        for name in ("mic", "sys"):
            item = channels.get(name)
            if isinstance(item, dict) and str(item.get("text") or "").strip():
                return str(item["text"]).strip()
    return str(response.get("text") or "").strip()


def transcribe_dictation(
    *,
    audio_path: str,
    engine: str,
    language: str,
    context_prompt: str,
    dictation_mode: str,
    target_language: str,
    timeout_sec: float,
) -> dict[str, Any]:
    prepare_t0 = time.monotonic()
    stt_audio_path, tmp_audio_path, audio_stats = _prepare_dictation_audio_with_stats(audio_path)
    prepare_t1 = time.monotonic()
    try:
        stt_t0 = time.monotonic()
        payload = _host_agent_request(
            "/api/agent/transcribe",
            {"audioPath": stt_audio_path, "language": language},
            timeout_sec=timeout_sec,
        )
        stt_t1 = time.monotonic()
        response = {
            "status": "ok",
            "text": str(payload.get("transcript") or "").strip(),
            "engine_used": engine,
            "provider": str(payload.get("provider") or engine),
            "chunks": int(payload.get("chunks") or 0),
            "language_used": language,
        }
        response.update(audio_stats)
        response["prepare_ms"] = int((prepare_t1 - prepare_t0) * 1000)
        response["stt_ms"] = int((stt_t1 - stt_t0) * 1000)
        return response
    finally:
        if tmp_audio_path is not None:
            tmp_audio_path.unlink(missing_ok=True)


def _wav_duration_ms(path: Path) -> int:
    try:
        with wave.open(str(path), "rb") as src:
            rate = src.getframerate()
            return int(src.getnframes() * 1000 / rate) if rate > 0 else 0
    except (OSError, wave.Error):
        return 0


def _trim_mono_voice(mono_path: Path) -> tuple[Path, Path | None, int]:
    # Normalize transport to compact mic-only PCM so the selected engine
    # receives the microphone channel deterministically.
    return mono_path, None, 0


def _resolve_ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    for candidate in FFMPEG_FALLBACKS:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return "ffmpeg"


def _prepare_dictation_audio_with_stats(audio_path: str) -> tuple[str, Path | None, dict[str, int]]:
    path = Path(audio_path)
    stats = {
        "audio_input_bytes": path.stat().st_size if path.exists() else 0,
        "audio_input_ms": 0,
        "stt_audio_bytes": 0,
        "stt_audio_ms": 0,
        "trim_leading_ms": 0,
    }
    try:
        with wave.open(str(path), "rb") as src:
            channels = src.getnchannels()
            sample_rate = src.getframerate()
            frames = src.getnframes()
            duration = frames / sample_rate if sample_rate > 0 else 0.0
            stats["audio_input_ms"] = int(duration * 1000)
            if src.getnframes() <= 0:
                raise DictationNoSpeechError("empty dictation audio")
    except (OSError, wave.Error):
        stats["stt_audio_bytes"] = stats["audio_input_bytes"]
        return audio_path, None, stats
    if channels != 2:
        stats["stt_audio_bytes"] = stats["audio_input_bytes"]
        stats["stt_audio_ms"] = stats["audio_input_ms"]
        return audio_path, None, stats

    tmp: Path | None = None
    if channels == 2:
        DICTATION_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            DICTATION_DIR.chmod(0o700)
        except OSError:
            pass
        with tempfile.NamedTemporaryFile(
            suffix=".dictation.mic.16k.wav",
            dir=DICTATION_DIR,
            delete=False,
        ) as handle:
            tmp = Path(handle.name)
        tmp.chmod(0o600)
        try:
            subprocess.run(
                [
                    _resolve_ffmpeg(), "-y", "-v", "error",
                    "-i", str(path),
                    "-af", "pan=mono|c0=c0",
                    "-ar", "16000",
                    "-ac", "1",
                    "-c:a", "pcm_s16le",
                    str(tmp),
                ],
                check=True,
                timeout=max(5.0, duration * 2.0),
            )
        except (OSError, subprocess.SubprocessError):
            tmp.unlink(missing_ok=True)
            tmp = None

    if tmp is None:
        raise DictationError("failed to prepare dictation audio for Yulu transcription")

    prepared, trimmed_tmp, offset_ms = _trim_mono_voice(tmp)
    if trimmed_tmp is not None:
        tmp.unlink(missing_ok=True)
        tmp = trimmed_tmp
    stats["trim_leading_ms"] = offset_ms
    stats["stt_audio_bytes"] = prepared.stat().st_size if prepared.exists() else 0
    stats["stt_audio_ms"] = _wav_duration_ms(prepared)
    return str(prepared), tmp, stats


def prepare_dictation_audio(audio_path: str) -> tuple[str, Path | None]:
    prepared, tmp, _stats = _prepare_dictation_audio_with_stats(audio_path)
    return prepared, tmp


def normalize_text(text: str) -> str:
    text = " ".join(text.split()).strip()
    text = re.sub(fr"(?<=[{CJK_CHAR_RE}])\s+(?=[{CJK_CHAR_RE}])", "", text)
    text = re.sub(fr"\s+([{re.escape(CJK_PUNCT_RE)}])", r"\1", text)
    text = re.sub(fr"([{re.escape(CJK_PUNCT_RE)}])\s+(?=[{CJK_CHAR_RE}])", r"\1", text)
    return text.strip()


def translation_not_needed(text: str, target_language: str) -> bool:
    target = target_language.strip().lower().replace("_", "-")
    if target not in {"", "en", "eng", "english", "en-us", "en-gb"}:
        return False
    return bool(re.search(r"[A-Za-z]", text)) and not re.search(fr"[{CJK_CHAR_RE}]", text)


def _agent_command(config: dict[str, Any]) -> list[str]:
    llm = config.get("llm", {}) if isinstance(config, dict) else {}
    llm = llm if isinstance(llm, dict) else {}
    if not llm.get("enabled", True):
        return []
    raw = llm.get("command")
    if isinstance(raw, list) and raw:
        return [str(x) for x in raw if str(x).strip()]
    agent = llm.get("agent", {})
    agent = agent if isinstance(agent, dict) else {}
    provider = str(agent.get("provider") or "").strip().lower()
    if provider == "hermes":
        return ["hermes", "-z", "--ignore-rules"]
    if provider in ("claude", "claude-code"):
        return ["claude", "--print"]
    if provider == "codex":
        return ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"]
    return []


def _run_agent_prompt(prompt: str, *, config: dict[str, Any], timeout_sec: float) -> str:
    if timeout_sec < MIN_STT_TIMEOUT_SEC:
        raise DictationError("dictation postprocess deadline exceeded")
    command = _agent_command(config)
    if not command:
        raise DictationError("dictation postprocess agent not configured")
    head = Path(command[0]).name
    input_text = prompt
    cmd = command
    if head == "hermes":
        input_text = None
        if "-z" in command or "--oneshot" in command:
            flag = "-z" if "-z" in command else "--oneshot"
            idx = command.index(flag)
            cmd = command[:idx + 1] + [prompt] + command[idx + 1:]
        elif "chat" in command:
            cmd = command + ["-q", prompt]
        else:
            cmd = command + ["-z", prompt]
    elif head == "codex" and "exec" in command:
        input_text = None
        cmd = command + [prompt]
    env = os.environ.copy()
    env["PATH"] = ":".join(
        dict.fromkeys(
            [
                str(Path.home() / ".local/bin"),
                "/opt/homebrew/bin",
                "/usr/local/bin",
                *env.get("PATH", "").split(":"),
            ]
        )
    )
    try:
        result = subprocess.run(
            cmd,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env=env,
        )
    except FileNotFoundError as exc:
        raise DictationError(f"dictation postprocess command not found: {cmd[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise DictationError("dictation postprocess timeout") from exc
    if result.returncode != 0:
        stderr = (result.stderr or result.stdout or "").strip()
        raise DictationError(f"dictation postprocess failed: {stderr[:240]}")
    output = (result.stdout or "").strip()
    if not output:
        raise DictationError("empty dictation postprocess result")
    return output


def postprocess_translation(
    *,
    text: str,
    context_prompt: str,
    target_language: str,
    timeout_sec: float,
    config: dict[str, Any] | None = None,
) -> str:
    vocab = glossary_hint(limit=160)
    prompt = "\n\n".join(
        part for part in [
            context_prompt.strip(),
            vocab,
            f"原始转录：\n---\n{text}\n---",
            f"将原始转录翻译成{target_language}。只输出最终可直接粘贴的正文。",
        ]
        if part
    )
    return normalize_text(_run_agent_prompt(prompt, config=config or _config(), timeout_sec=timeout_sec))


def current_frontmost_app() -> dict[str, str]:
    proc = subprocess.run(
        [
            "osascript",
            "-e", 'tell application "System Events"',
            "-e", 'set frontApp to first application process whose frontmost is true',
            "-e", 'return (name of frontApp) & "\n" & (bundle identifier of frontApp)',
            "-e", "end tell",
        ],
        text=True,
        capture_output=True,
        timeout=2.5,
    )
    if proc.returncode != 0:
        return {}
    lines = [line.strip() for line in proc.stdout.splitlines()]
    return {
        "target_app_name": lines[0] if lines else "",
        "target_bundle_id": lines[1] if len(lines) > 1 else "",
    }


def activate_target_app(*, target_bundle_id: str = "", target_app_name: str = "") -> None:
    if target_bundle_id:
        cmd = ["open", "-b", target_bundle_id]
    elif target_app_name:
        cmd = ["open", "-a", target_app_name]
    else:
        return
    try:
        subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=0.8,
        )
    except subprocess.TimeoutExpired:
        pass
    time.sleep(0.05)


def copy_to_clipboard(text: str) -> None:
    subprocess.run(["pbcopy"], input=text, text=True, check=True, timeout=0.5)


def current_frontmost_matches(*, target_bundle_id: str = "", target_app_name: str = "") -> bool:
    if not target_bundle_id and not target_app_name:
        return True
    front = current_frontmost_app()
    front_bundle = str(front.get("target_bundle_id") or "")
    front_name = str(front.get("target_app_name") or "")
    return bool(target_bundle_id and front_bundle == target_bundle_id) or bool(
        target_app_name and front_name == target_app_name
    )


def paste_current_clipboard(*, text: str = "", target_bundle_id: str = "", target_app_name: str = "") -> dict[str, Any]:
    payload = {
        "action": "paste_clipboard",
        "target_bundle_id": target_bundle_id,
        "target_app_name": target_app_name,
    }
    if text:
        payload["text"] = text
    resp = None
    try:
        resp = _socket_send(
            STATUS_AGENT_SOCKET,
            payload,
            timeout=2.0,
        )
    except DictationError:
        pass
    if resp:
        if resp.get("ok"):
            return resp
        if resp.get("error") == "target_not_front":
            front = resp.get("front_app_name") or resp.get("front_bundle_id") or "unknown"
            if front != "loginwindow" or not current_frontmost_matches(
                target_bundle_id=target_bundle_id,
                target_app_name=target_app_name,
            ):
                raise DictationError(f"target app not frontmost: {front}")
    if text:
        copy_to_clipboard(text)
    activate_target_app(target_bundle_id=target_bundle_id, target_app_name=target_app_name)
    if not current_frontmost_matches(target_bundle_id=target_bundle_id, target_app_name=target_app_name):
        front = current_frontmost_app()
        front_bundle = str(front.get("target_bundle_id") or "")
        front_name = str(front.get("target_app_name") or "")
        raise DictationError(f"target app not frontmost: {front_name or front_bundle or 'unknown'}")
    subprocess.run(
        ["osascript", "-e", 'tell application "System Events" to keystroke "v" using command down'],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=0.8,
    )
    return {"ok": True, "method": "osascript"}


def write_current_text(*, text: str, target_bundle_id: str = "", target_app_name: str = "") -> dict[str, Any]:
    resp = paste_current_clipboard(
        text=text,
        target_bundle_id=target_bundle_id,
        target_app_name=target_app_name,
    )
    result = {
        "pasted": True,
        "paste_method": str(resp.get("method") or ""),
    }
    if "verified" in resp:
        result["paste_verified"] = bool(resp["verified"])
    if resp.get("accessibility_error"):
        result["accessibility_error"] = str(resp["accessibility_error"])
    return result


def open_voice_chat_url(url: str) -> None:
    try:
        _socket_send(STATUS_AGENT_SOCKET, {"action": "open_voice_chat", "url": url}, timeout=2.0)
        return
    except DictationError:
        pass
    subprocess.run(
        ["open", url],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


class _NoHostRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open_host_request_without_redirects(request: urllib.request.Request, timeout: float):
    return urllib.request.build_opener(_NoHostRedirectHandler()).open(request, timeout=timeout)


def _validated_voice_chat_origin(base_url: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(base_url.strip())
        host = parsed.hostname or ""
        address = ipaddress.ip_address(host)
        port = parsed.port
    except (ValueError, TypeError) as exc:
        raise DictationError("voice chat URL must use the exact local Yulu Host origin") from exc
    expected_port = urllib.parse.urlsplit(DEFAULT_UI_BASE_URL).port
    if (
        parsed.scheme != "http"
        or not address.is_loopback
        or port != expected_port
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise DictationError("voice chat URL must use the exact local Yulu Host origin")
    canonical_host = f"[{address.compressed}]" if address.version == 6 else address.compressed
    return f"http://{canonical_host}:{port}"


def send_voice_chat(
    *,
    question: str,
    session_id: str = "",
    base_url: str = DEFAULT_UI_BASE_URL,
    open_console: bool = True,
) -> dict[str, Any]:
    host_origin = _validated_voice_chat_origin(base_url)
    token_doc = _load_json(MCP_TOKEN_PATH)
    token = str(token_doc.get("token") or "").strip()
    if not token:
        raise DictationError("Yulu Host token is unavailable")
    payload = {"question": question, "defer": True}
    if session_id:
        payload["sessionId"] = session_id
    data = json.dumps(payload).encode("utf-8")
    url = host_origin + "/api/voice-chat/ask"
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with _open_host_request_without_redirects(req, timeout=125) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise DictationError(f"voice chat failed: HTTP {exc.code} {body}") from exc
    except OSError as exc:
        raise DictationError(f"voice chat unavailable: {exc}") from exc
    if not result.get("ok"):
        raise DictationError(f"voice chat failed: {result.get('error', 'unknown error')}")
    if open_console and result.get("url"):
        relative_url = str(result["url"])
        if not relative_url.startswith("/") or relative_url.startswith("//"):
            raise DictationError("voice chat failed: invalid local console URL")
        open_voice_chat_url(host_origin + relative_url)
    return result


def warm_dictation_engine(*, engine: str, timeout_sec: float, target_language: str = "") -> dict[str, Any]:
    payload = _host_agent_request(
        "/api/agent/transcription/warm",
        {},
        timeout_sec=timeout_sec,
    )
    warm_engine = str(payload.get("provider") or engine)
    return {
        "text": f"warmed {warm_engine}",
        "engine": engine,
        "warmed_engine": warm_engine,
        "target_language": target_language,
        "ok": True,
    }


def process_audio(
    *,
    state: dict[str, Any],
    engine: str,
    language: str,
    prompt_slug: str,
    prompt_id: str | None,
    target_language: str,
    timeout_sec: float,
    copy: bool,
    paste: bool,
    context_limit: int,
) -> dict[str, Any]:
    t0 = time.monotonic()
    context = render_context_prompt(
        prompt_slug=prompt_slug,
        prompt_id=prompt_id,
        limit=context_limit,
        target_language=target_language,
    )
    t1 = time.monotonic()
    realtime_result = state.get("realtime_result")
    if not target_language and isinstance(realtime_result, dict):
        audio_path = Path(str(state["audio_path"]))
        audio_ms = _wav_duration_ms(audio_path)
        response = {
            "text": str(realtime_result.get("stableText") or "").strip(),
            "engine_used": engine,
            "provider": str(realtime_result.get("captionProvider") or engine),
            "language_used": language,
            "prepare_ms": 0,
            "stt_ms": int(state.get("realtime_stop_ms") or 0),
            "audio_input_bytes": audio_path.stat().st_size if audio_path.exists() else 0,
            "stt_audio_bytes": audio_path.stat().st_size if audio_path.exists() else 0,
            "audio_input_ms": audio_ms,
            "stt_audio_ms": audio_ms,
            "trim_leading_ms": 0,
        }
        transcription_mode = "realtime"
    else:
        response = transcribe_dictation(
            audio_path=str(state["audio_path"]),
            engine=engine,
            language=language,
            context_prompt=context,
            dictation_mode="translate" if target_language else "dictate",
            target_language=target_language,
            timeout_sec=timeout_sec,
        )
        transcription_mode = "batch"
    raw_text = extract_response_text(response)
    text = normalize_text(raw_text)
    if not text:
        raise DictationNoSpeechError("empty dictation result")
    postprocess_ms = 0
    if target_language and not translation_not_needed(text, target_language):
        postprocess_t0 = time.monotonic()
        text = postprocess_translation(
            text=text,
            context_prompt=context,
            target_language=target_language,
            timeout_sec=timeout_sec - (time.monotonic() - t0),
        )
        postprocess_ms = int((time.monotonic() - postprocess_t0) * 1000)
    copy_ms = 0
    if copy or paste:
        copy_t0 = time.monotonic()
        copy_to_clipboard(text)
        copy_ms = int((time.monotonic() - copy_t0) * 1000)
    paste_ms = 0
    if paste:
        paste_t0 = time.monotonic()
        try:
            write_result = write_current_text(
                text=text,
                target_bundle_id=str(state.get("target_bundle_id") or ""),
                target_app_name=str(state.get("target_app_name") or ""),
            )
        except Exception as exc:
            raise DictationPasteError(str(exc)) from exc
        paste_ms = int((time.monotonic() - paste_t0) * 1000)
    else:
        write_result = {"pasted": False}
    t2 = time.monotonic()
    result = {
        "text": text,
        "audio_path": state["audio_path"],
        "engine": response.get("engine_used") or engine,
        "transcription_provider": response.get("provider") or response.get("engine_used") or engine,
        "transcription_mode": transcription_mode,
        "language": response.get("language_used") or language,
        "prompt_slug": prompt_slug,
        "prompt_id": prompt_id,
        "target_language": target_language,
        "copied": bool(copy or paste),
        "pasted": bool(paste),
        "context_ms": int((t1 - t0) * 1000),
        "prepare_ms": int(response.get("prepare_ms") or 0),
        "stt_ms": int(response.get("stt_ms") or 0),
        "postprocess_ms": postprocess_ms,
        "realtime_stop_ms": int(state.get("realtime_stop_ms") or 0),
        "copy_ms": copy_ms,
        "paste_ms": paste_ms,
        "audio_input_bytes": int(response.get("audio_input_bytes") or 0),
        "stt_audio_bytes": int(response.get("stt_audio_bytes") or 0),
        "audio_input_ms": int(response.get("audio_input_ms") or 0),
        "stt_audio_ms": int(response.get("stt_audio_ms") or 0),
        "trim_leading_ms": int(response.get("trim_leading_ms") or 0),
        "post_stop_ms": int((t2 - t0) * 1000),
    }
    result.update(write_result)
    return result


def _print(result: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["text"])


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--engine", help="deprecated compatibility option; Yulu uses the engine selected in Settings")
    parser.add_argument("--language", help="transcription language hint, default from config or zh")
    parser.add_argument("--prompt", default=None, help=f"prompt slug, default {DEFAULT_PROMPT_SLUG}; use 'none' to skip")
    parser.add_argument("--prompt-id", default=None, help="prompt id, overrides --prompt")
    parser.add_argument("--translate-to", default=None, help=f"translate dictation to this language via {DEFAULT_TRANSLATE_PROMPT_SLUG}")
    parser.add_argument("--timeout-sec", type=float, default=None, help="post-stop STT timeout budget")
    parser.add_argument("--context-limit", type=int, default=None, help=f"max prompt chars sent as STT context, default {DEFAULT_CONTEXT_LIMIT}")
    parser.add_argument("--no-paste", action="store_true", help="copy only; do not paste into the focused app")
    parser.add_argument("--no-copy", action="store_true", help="with --no-paste, do not write the clipboard")
    parser.add_argument("--target-bundle-id", default="", help=argparse.SUPPRESS)
    parser.add_argument("--target-app-name", default="", help=argparse.SUPPRESS)
    parser.add_argument("--json", action="store_true", help="print machine-readable result")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Experimental low-latency Yulu voice input.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    start = sub.add_parser("start", help="start a mic-only dictation recording")
    _add_common(start)
    start.add_argument("--silence-seconds", type=float, default=MANUAL_SILENCE_SECONDS)
    stop = sub.add_parser("stop", help="stop, transcribe, copy, and paste unless disabled")
    _add_common(stop)
    stop.add_argument("--deadline-sec", type=float, default=None, help=f"post-stop wall-clock budget, default {DEFAULT_HERMES_DEADLINE_SEC}")
    toggle = sub.add_parser("toggle", help="start dictation, or stop the active dictation")
    _add_common(toggle)
    toggle.add_argument("--deadline-sec", type=float, default=None, help=f"post-stop wall-clock budget, default {DEFAULT_HERMES_DEADLINE_SEC}")
    toggle.add_argument("--silence-seconds", type=float, default=MANUAL_SILENCE_SECONDS)
    once = sub.add_parser("once", help="record for a fixed duration, then process")
    _add_common(once)
    once.add_argument("--duration", type=float, default=1.2, help="recording duration in seconds")
    once.add_argument("--deadline-sec", type=float, default=None, help=f"overall once wall-clock budget, default {DEFAULT_HERMES_DEADLINE_SEC}")
    once.add_argument("--silence-seconds", type=float, default=3.0)
    ask = sub.add_parser("ask", help="record a question, send it to Agent Console, and open the chat")
    _add_common(ask)
    ask.add_argument("--duration", type=float, default=1.2, help="recording duration in seconds")
    ask.add_argument("--deadline-sec", type=float, default=None, help=f"overall capture+transcription budget before agent call, default {DEFAULT_HERMES_DEADLINE_SEC}")
    ask.add_argument("--silence-seconds", type=float, default=3.0)
    ask.add_argument("--session-id", default="", help="continue an existing Agent Console session")
    ask.add_argument("--ui-url", default=DEFAULT_UI_BASE_URL, help=f"Yulu UI base URL, default {DEFAULT_UI_BASE_URL}")
    ask.add_argument("--no-open", action="store_true", help="do not open Agent Console after sending")
    ask_toggle = sub.add_parser("ask-toggle", help="start a voice-chat recording, or stop and send it")
    _add_common(ask_toggle)
    ask_toggle.add_argument("--deadline-sec", type=float, default=None, help=f"post-stop wall-clock budget, default {DEFAULT_HERMES_DEADLINE_SEC}")
    ask_toggle.add_argument("--silence-seconds", type=float, default=MANUAL_SILENCE_SECONDS)
    ask_toggle.add_argument("--session-id", default="", help="continue an existing Agent Console session")
    ask_toggle.add_argument("--ui-url", default=DEFAULT_UI_BASE_URL, help=f"Yulu UI base URL, default {DEFAULT_UI_BASE_URL}")
    ask_toggle.add_argument("--no-open", action="store_true", help="do not open Agent Console after sending")
    warm = sub.add_parser("warm", help="pre-warm the selected Yulu transcription engine")
    warm.add_argument("--engine", help="deprecated compatibility option; Yulu uses the engine selected in Settings")
    warm.add_argument("--translate-to", default=None, help="pre-warm the translation engine for this target language")
    warm.add_argument("--timeout-sec", type=float, default=60.0)
    warm.add_argument("--json", action="store_true")
    cancel = sub.add_parser("cancel", help="cancel the active dictation without transcribing or pasting")
    cancel.add_argument("--json", action="store_true")
    sub.add_parser("status", help="show active dictation state")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "status":
            print(json.dumps(_state(), ensure_ascii=False, indent=2))
            return 0

        if args.cmd == "cancel":
            _print(cancel_recording(), as_json=args.json)
            return 0

        config = _config()
        if args.cmd == "warm":
            target_language = str(args.translate_to or "").strip()
            engine = resolve_translation_engine(config, args.engine, target_language) if target_language else resolve_engine(config, args.engine)
            result = warm_dictation_engine(
                engine=engine,
                timeout_sec=args.timeout_sec,
                target_language=target_language,
            )
            _print(result, as_json=args.json)
            return 0

        dict_cfg = _dictation_config(config)
        engine = resolve_engine(config, args.engine)
        language = resolve_language(config, args.language)
        target_language = str(args.translate_to or "").strip()
        stored_state = _state() if args.cmd in ("stop", "toggle", "ask", "ask-toggle") else {}
        if not target_language and args.cmd in ("stop", "toggle"):
            target_language = str(stored_state.get("target_language") or "").strip()
        if target_language:
            engine = resolve_translation_engine(config, args.engine, target_language)
        translate_prompt_slug = str(dict_cfg.get("translate_prompt_slug") or DEFAULT_TRANSLATE_PROMPT_SLUG)
        if target_language and not args.prompt and not args.prompt_id:
            prompt_slug = translate_prompt_slug
        else:
            prompt_slug = args.prompt or dict_cfg.get("prompt_slug") or DEFAULT_PROMPT_SLUG
        is_translate = bool(target_language)
        default_timeout = (
            DEFAULT_HERMES_TRANSLATE_TIMEOUT_SEC if is_translate else
            DEFAULT_HERMES_TIMEOUT_SEC
        )
        default_deadline = (
            DEFAULT_HERMES_TRANSLATE_DEADLINE_SEC if is_translate else
            DEFAULT_HERMES_DEADLINE_SEC
        )
        if args.timeout_sec is not None:
            timeout_sec = float(args.timeout_sec)
        elif is_translate:
            timeout_sec = float(dict_cfg.get("translate_timeout_sec", default_timeout))
        else:
            timeout_sec = float(dict_cfg.get("timeout_sec", default_timeout))
        context_limit = int(
            args.context_limit if args.context_limit is not None
            else dict_cfg.get("context_limit", DEFAULT_CONTEXT_LIMIT)
        )
        if is_translate:
            deadline_sec = float(dict_cfg.get("translate_deadline_sec", default_deadline))
        else:
            deadline_sec = float(dict_cfg.get("deadline_sec", default_deadline))
        if hasattr(args, "deadline_sec") and args.deadline_sec is not None:
            deadline_sec = float(args.deadline_sec)
        if args.no_copy and not args.no_paste:
            raise DictationError("--no-copy requires --no-paste because paste uses the clipboard")
        will_copy = False if args.cmd in ("ask", "ask-toggle") else not args.no_copy
        will_paste = False if args.cmd in ("ask", "ask-toggle") else not args.no_paste
        deadline_reserve_sec = (
            PASTE_RESERVE_SEC if will_paste else
            CLIPBOARD_RESERVE_SEC if will_copy else
            DEADLINE_RESERVE_SEC
        )

        previous_voice_session_id = str(stored_state.get("voice_chat_session_id") or "") if args.cmd in ("ask", "ask-toggle") else ""
        active_state = active_dictation_state() if args.cmd in ("toggle", "ask-toggle") else None
        toggle_stops = active_state is not None
        if args.cmd == "ask-toggle" and toggle_stops and str(active_state.get("intent") or "dictation") != "voice_chat":
            raise DictationError("active dictation is not voice chat")

        if args.cmd == "start" or (args.cmd in ("toggle", "ask-toggle") and not toggle_stops):
            state = start_recording(
                engine=engine,
                language=language,
                prompt_slug=prompt_slug,
                prompt_id=args.prompt_id,
                target_language=target_language,
                silence_seconds=args.silence_seconds,
                capture_target=not args.no_paste,
                intent="voice_chat" if args.cmd == "ask-toggle" else "dictation",
                target_bundle_id=args.target_bundle_id,
                target_app_name=args.target_app_name,
            )
            _print({"text": state["audio_path"], "action": "start", **state}, as_json=args.json)
            return 0

        if args.cmd in ("once", "ask"):
            once_started = time.monotonic()
            stop_started = None
            state = start_recording(
                engine=engine,
                language=language,
                prompt_slug=prompt_slug,
                prompt_id=args.prompt_id,
                target_language=target_language,
                silence_seconds=args.silence_seconds,
                capture_target=not args.no_paste,
                intent="voice_chat" if args.cmd == "ask" else "dictation",
                target_bundle_id=args.target_bundle_id,
                target_app_name=args.target_app_name,
            )
            time.sleep(max(0.1, args.duration))
        else:
            once_started = None
            stop_started = time.monotonic()
            state = stored_state or _state()

        state = stop_recording()
        _write_json(STATE_PATH, state)
        if once_started is not None:
            remaining = deadline_sec - (time.monotonic() - once_started)
            if remaining <= deadline_reserve_sec + MIN_STT_TIMEOUT_SEC:
                raise DictationError(f"dictation deadline exceeded before STT ({deadline_sec:.1f}s)")
            timeout_sec = min(timeout_sec, remaining - deadline_reserve_sec)
        elif stop_started is not None:
            remaining = deadline_sec - (time.monotonic() - stop_started)
            if remaining <= deadline_reserve_sec + MIN_STT_TIMEOUT_SEC:
                raise DictationError(f"dictation deadline exceeded before STT ({deadline_sec:.1f}s)")
            timeout_sec = min(timeout_sec, remaining - deadline_reserve_sec)
        engine = resolve_engine(config, args.engine or state.get("engine") or engine)
        language = args.language or state.get("language") or language
        prompt_slug = args.prompt or state.get("prompt_slug") or prompt_slug
        prompt_id = args.prompt_id or state.get("prompt_id")
        target_language = target_language or str(state.get("target_language") or "")
        result = process_audio(
            state=state,
            engine=str(engine),
            language=str(language),
            prompt_slug=str(prompt_slug),
            prompt_id=str(prompt_id) if prompt_id else None,
            target_language=target_language,
            timeout_sec=timeout_sec,
            copy=will_copy,
            paste=will_paste,
            context_limit=context_limit,
        )
        if once_started is not None:
            result["wall_ms"] = int((time.monotonic() - once_started) * 1000)
        elif stop_started is not None:
            result["wall_ms"] = int((time.monotonic() - stop_started) * 1000)
        if toggle_stops:
            result["action"] = "stop"
        if args.cmd not in ("ask", "ask-toggle"):
            try:
                append_history(result)
            except Exception:
                pass
        if args.cmd in ("ask", "ask-toggle"):
            result["chat"] = send_voice_chat(
                question=result["text"],
                session_id=args.session_id or previous_voice_session_id,
                base_url=args.ui_url,
                open_console=not args.no_open,
            )
        next_state: dict[str, Any] = {"last_result": result, "updated_at": _now()}
        if args.cmd in ("ask", "ask-toggle"):
            next_state["voice_chat_session_id"] = str(result["chat"].get("sessionId") or previous_voice_session_id)
        _write_json(STATE_PATH, next_state)
        _print(result, as_json=args.json)
        return 0
    except Exception as exc:
        if getattr(args, "json", False):
            state = _state()
            _print(
                dictation_error_payload(exc, audio_path=str(state.get("audio_path") or "")),
                as_json=True,
            )
        print(f"dictate error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
