"""STTDaemonApp — wires scheduler, runtime, vocab cache, control server, sessions."""

from __future__ import annotations

import asyncio
import os
import signal
import uuid
from pathlib import Path
from typing import Optional

from .config import DaemonConfig
from .control_server import ControlServer
from .logging import JsonLogger, open_log_sink
from .protocol import (
    JobKind, ErrorCode, ErrorEvent, OkResponse,
    HealthRequest, HealthResponse,
    WarmUpRequest,
    VocabReloadRequest, VocabReloadedResponse,
    TranscribeRequest, TranscribeResponse,
    CancelRequest,
    SubscribeSessionRequest, UnsubscribeSessionRequest,
)
from .runtime import STTRuntime, STTBackend
from .scheduler import STTScheduler, Job
from .vocab_cache import VocabCache


class STTDaemonApp:
    def __init__(
        self,
        config: DaemonConfig,
        *,
        backends: dict[str, STTBackend],
    ):
        self.config = config
        self.logger = JsonLogger(open_log_sink(config.log_path))
        self.vocab_cache = VocabCache(config.vocab_db_path, autoreload=True)
        self.runtime = STTRuntime(backends=backends)
        self.scheduler = STTScheduler(
            runtime=self.runtime,
            live_chunk_max_per_session=config.live_chunk_max_per_session,
        )
        self.control_server = ControlServer(
            socket_path=config.socket_path,
            logger=self.logger,
            max_connections=config.max_concurrent_connections,
        )
        self._active_sessions: dict[str, "_SessionEntry"] = {}

    async def start(self) -> None:
        self.vocab_cache.load()
        await self.scheduler.start()
        self._register_handlers()
        await self.control_server.start()
        self._write_pid()
        self._install_signal_handlers()
        self.logger.info("daemon_ready", vocab=len(self.vocab_cache.prompt_terms))

    async def stop(self) -> None:
        await self.control_server.stop()
        await self.scheduler.stop()
        await self.runtime.shutdown()
        self._remove_pid()
        self.logger.info("daemon_stopped")

    def _register_handlers(self) -> None:
        cs = self.control_server
        cs.register(HealthRequest, self._on_health)
        cs.register(WarmUpRequest, self._on_warm_up)
        cs.register(VocabReloadRequest, self._on_vocab_reload)
        cs.register(TranscribeRequest, self._on_transcribe)
        cs.register(CancelRequest, self._on_cancel)
        cs.register(SubscribeSessionRequest, self._on_subscribe_session)
        cs.register(UnsubscribeSessionRequest, self._on_unsubscribe_session)

    async def _on_health(self, msg, writer):
        return HealthResponse(
            ready=True,
            model_loaded=any(self.runtime.is_ready(e) for e in self.runtime.backends),
            vocab_size=len(self.vocab_cache.prompt_terms) + len(self.vocab_cache.replace_rules),
            in_flight_jobs=self.scheduler.in_flight_count(),
            active_sessions=len(self._active_sessions),
        )

    async def _on_warm_up(self, msg: WarmUpRequest, writer):
        engine = msg.engine or self.config.default_engine
        try:
            await self.runtime.warm_up(engine)
            return OkResponse(detail=f"warmed {engine}")
        except Exception as exc:
            return ErrorEvent(code=ErrorCode.ENGINE_UNAVAILABLE, message=str(exc))

    async def _on_vocab_reload(self, msg, writer):
        self.vocab_cache.reload()
        return VocabReloadedResponse(
            prompt_terms=len(self.vocab_cache.prompt_terms),
            replace_rules=len(self.vocab_cache.replace_rules),
        )

    async def _on_transcribe(self, msg: TranscribeRequest, writer):
        if not Path(msg.audio_path).exists():
            return ErrorEvent(
                job_id=msg.job_id,
                code=ErrorCode.AUDIO_NOT_FOUND,
                message=f"audio not found: {msg.audio_path}",
            )
        self.vocab_cache.maybe_reload()
        initial_prompt = self.vocab_cache.inject_prompt(
            meeting_title=msg.meeting_title or "",
        )
        job = Job(
            job_id=msg.job_id,
            kind=msg.kind,
            engine=msg.engine,
            language=msg.language,
            audio_path=msg.audio_path,
            initial_prompt=initial_prompt,
            session_id=msg.session_id,
            meeting_title=msg.meeting_title,
        )
        fut = await self.scheduler.submit(job)
        try:
            result = await fut
        except asyncio.CancelledError:
            return TranscribeResponse(
                job_id=msg.job_id, status="cancelled",
                engine_used=msg.engine, language_used=msg.language,
                text="", raw_text="", segments=[],
                vocab_prompt_terms_count=0, vocab_replacements_count=0,
                duration_ms=0, error="cancelled",
            )
        except Exception as exc:
            return ErrorEvent(job_id=msg.job_id, code=ErrorCode.INTERNAL, message=str(exc))

        cleaned, n_replace = self.vocab_cache.apply_replacements(result.text)
        return TranscribeResponse(
            job_id=msg.job_id,
            status="ok",
            engine_used=msg.engine,
            language_used=result.language or msg.language,
            text=cleaned,
            raw_text=result.raw_text,
            segments=result.segments,
            vocab_prompt_terms_count=initial_prompt.count(",") + (1 if initial_prompt else 0),
            vocab_replacements_count=n_replace,
            duration_ms=result.duration_ms,
        )

    async def _on_cancel(self, msg: CancelRequest, writer):
        ok = await self.scheduler.cancel(msg.job_id)
        return OkResponse(detail="cancelled" if ok else "not_found")

    async def _on_subscribe_session(self, msg: SubscribeSessionRequest, writer):
        return ErrorEvent(
            code=ErrorCode.INTERNAL,
            message="subscribe_session not implemented until Phase 4",
        )

    async def _on_unsubscribe_session(self, msg: UnsubscribeSessionRequest, writer):
        return ErrorEvent(
            code=ErrorCode.INTERNAL,
            message="unsubscribe_session not implemented until Phase 4",
        )

    def _write_pid(self) -> None:
        self.config.pid_file.parent.mkdir(parents=True, exist_ok=True)
        self.config.pid_file.write_text(str(os.getpid()), encoding="utf-8")

    def _remove_pid(self) -> None:
        try:
            self.config.pid_file.unlink()
        except FileNotFoundError:
            pass

    def _install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(self._handle_signal(s)))
            except NotImplementedError:
                pass
        try:
            loop.add_signal_handler(signal.SIGHUP, self._on_sighup)
        except NotImplementedError:
            pass

    def _on_sighup(self) -> None:
        self.vocab_cache.reload()
        self.logger.info("vocab_reloaded_via_sighup",
                          terms=len(self.vocab_cache.prompt_terms),
                          rules=len(self.vocab_cache.replace_rules))

    async def _handle_signal(self, sig) -> None:
        self.logger.info("signal_received", sig=int(sig))
        await self.stop()


class _SessionEntry:
    """Placeholder; replaced by Phase 4."""
    pass
