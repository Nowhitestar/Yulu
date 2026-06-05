"""STTDaemonApp — wires scheduler, runtime, vocab cache, control server, sessions."""

from __future__ import annotations

import asyncio
import os
import signal
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
from .live_session import LiveSession, LiveSessionManager
from .runtime import (
    STTRuntime, STTBackend,
    _extract_channel, _downmix_stereo_to_mono,
    _channel_rms_dbfs, EMPTY_CHANNEL_DBFS_THRESHOLD,
)
from .scheduler import STTScheduler, Job
from .vocab_cache import VocabCache
from .wav_inspect import WavLayout, classify

import tempfile


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
        self.runtime = STTRuntime(
            backends=backends,
            # Final-transcription policy (BUG 3 + BUG 8). `mode` orders local vs.
            # the user's cloud_command; `whisper_model_present` enables the
            # mlx→whisper fallback only when a whisper.cpp model is configured.
            mode=config.mode,
            whisper_model_present=bool(config.whisper_model),
            cloud_command_present=bool(config.cloud_command),
            logger=self.logger,
        )
        self.scheduler = STTScheduler(
            runtime=self.runtime,
            live_chunk_max_per_session=config.live_chunk_max_per_session,
        )
        self.control_server = ControlServer(
            socket_path=config.socket_path,
            logger=self.logger,
            max_connections=config.max_concurrent_connections,
        )
        self.live_sessions = LiveSessionManager(
            scheduler=self.scheduler,
            vocab_cache=self.vocab_cache,
            sessions_dir=config.sessions_dir,
            on_partial=self._broadcast_partial,
        )
        self._subscribers: dict[str, list[asyncio.StreamWriter]] = {}
        # Set when stop() completes; __main__'s _run awaits this to know
        # when to exit cleanly without needing a parent-task cancellation
        # ping from the signal handler.
        self.stopped_event = asyncio.Event()

    async def start(self) -> None:
        self.vocab_cache.load()
        await self.scheduler.start()
        self._register_handlers()
        await self.control_server.start()
        self._write_pid()
        self._install_signal_handlers()
        recovered = self.live_sessions.recover_from_disk()
        self.logger.info("daemon_ready",
                          vocab=len(self.vocab_cache.prompt_terms),
                          recovered_sessions=recovered)

    async def stop(self) -> None:
        if self.stopped_event.is_set():
            return  # idempotent — signal handler + outer cleanup both reach here
        await self.control_server.stop()
        await self.scheduler.stop()
        await self.runtime.shutdown()
        self._remove_pid()
        self.logger.info("daemon_stopped")
        self.stopped_event.set()

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
            active_sessions=len(self.live_sessions.active_sessions()),
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

        # Channel-aware dispatch (Phase 3). When channel_split=False, the
        # daemon classifies as MONO and runs exactly one scheduler job on
        # the original file — preserving the pre-Phase-3 behavior. The
        # classify() call must live inside the try/except so a vanishing
        # file or malformed RIFF returns a clean ErrorEvent instead of
        # crashing the connection.
        layout = WavLayout.MONO  # safe default for the cancelled/error response
        try:
            if not msg.channel_split:
                layout = WavLayout.MONO
            else:
                layout = classify(Path(msg.audio_path))

            if layout is WavLayout.MONO:
                result = await self._run_one_job(msg, msg.audio_path, initial_prompt)
                cleaned, n_replace = self.vocab_cache.apply_replacements(result.text)
                return TranscribeResponse(
                    job_id=msg.job_id, status="ok",
                    engine_used=msg.engine,
                    language_used=result.language or msg.language,
                    text=cleaned, raw_text=result.raw_text, segments=result.segments,
                    vocab_prompt_terms_count=initial_prompt.count(",") + (1 if initial_prompt else 0),
                    vocab_replacements_count=n_replace,
                    duration_ms=result.duration_ms,
                    layout=layout.value,
                )

            if layout is WavLayout.LEGACY_STEREO:
                self.logger.warn("legacy_stereo_wav_no_source_separation",
                                  path=msg.audio_path)
                tmp_path = Path(tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name)
                try:
                    _downmix_stereo_to_mono(Path(msg.audio_path), tmp_path)
                    result = await self._run_one_job(msg, str(tmp_path), initial_prompt)
                finally:
                    tmp_path.unlink(missing_ok=True)
                cleaned, n_replace = self.vocab_cache.apply_replacements(result.text)
                return TranscribeResponse(
                    job_id=msg.job_id, status="ok",
                    engine_used=msg.engine,
                    language_used=result.language or msg.language,
                    text=cleaned, raw_text=result.raw_text, segments=result.segments,
                    vocab_prompt_terms_count=initial_prompt.count(",") + (1 if initial_prompt else 0),
                    vocab_replacements_count=n_replace,
                    duration_ms=result.duration_ms,
                    layout=layout.value,
                )

            # DUAL_TRACK — allocate inside try so that a failure between
            # the two NamedTemporaryFile() calls cannot leak the first file.
            tmp_mic: Optional[Path] = None
            tmp_sys: Optional[Path] = None
            mic_channel: dict = {}
            sys_channel: dict = {}
            language_used = msg.language
            total_duration_ms = 0
            total_replacements = 0
            try:
                tmp_mic = Path(tempfile.NamedTemporaryFile(suffix=".mic.wav", delete=False).name)
                tmp_sys = Path(tempfile.NamedTemporaryFile(suffix=".sys.wav", delete=False).name)
                _extract_channel(Path(msg.audio_path), channel=0, out_path=tmp_mic)
                _extract_channel(Path(msg.audio_path), channel=1, out_path=tmp_sys)

                mic_dbfs = _channel_rms_dbfs(tmp_mic)
                sys_dbfs = _channel_rms_dbfs(tmp_sys)

                if mic_dbfs > EMPTY_CHANNEL_DBFS_THRESHOLD:
                    mic_r = await self._run_one_job(msg, str(tmp_mic), initial_prompt,
                                                     job_id_suffix=":mic")
                    mic_clean, mic_n = self.vocab_cache.apply_replacements(mic_r.text)
                    mic_channel = {
                        "text": mic_clean,
                        "raw_text": mic_r.raw_text,
                        "segments": mic_r.segments,
                        "duration_ms": mic_r.duration_ms,
                    }
                    language_used = mic_r.language or language_used
                    total_duration_ms += mic_r.duration_ms
                    total_replacements += mic_n
                else:
                    mic_channel = {"skipped_silent": True, "text": "", "segments": []}

                if sys_dbfs > EMPTY_CHANNEL_DBFS_THRESHOLD:
                    sys_r = await self._run_one_job(msg, str(tmp_sys), initial_prompt,
                                                     job_id_suffix=":sys")
                    sys_clean, sys_n = self.vocab_cache.apply_replacements(sys_r.text)
                    sys_channel = {
                        "text": sys_clean,
                        "raw_text": sys_r.raw_text,
                        "segments": sys_r.segments,
                        "duration_ms": sys_r.duration_ms,
                    }
                    if language_used == msg.language:
                        language_used = sys_r.language or language_used
                    total_duration_ms += sys_r.duration_ms
                    total_replacements += sys_n
                else:
                    sys_channel = {"skipped_silent": True, "text": "", "segments": []}
            finally:
                if tmp_mic is not None:
                    tmp_mic.unlink(missing_ok=True)
                if tmp_sys is not None:
                    tmp_sys.unlink(missing_ok=True)

            return TranscribeResponse(
                job_id=msg.job_id, status="ok",
                engine_used=msg.engine,
                language_used=language_used,
                text="", raw_text="", segments=[],
                vocab_prompt_terms_count=initial_prompt.count(",") + (1 if initial_prompt else 0),
                vocab_replacements_count=total_replacements,
                duration_ms=total_duration_ms,
                layout=layout.value,
                channels={
                    "mic": mic_channel,
                    "sys": sys_channel,
                },
            )
        except asyncio.CancelledError:
            return TranscribeResponse(
                job_id=msg.job_id, status="cancelled",
                engine_used=msg.engine, language_used=msg.language,
                text="", raw_text="", segments=[],
                vocab_prompt_terms_count=0, vocab_replacements_count=0,
                duration_ms=0, error="cancelled",
                layout=layout.value,
            )
        except Exception as exc:
            return ErrorEvent(job_id=msg.job_id, code=ErrorCode.INTERNAL, message=str(exc))

    async def _run_one_job(
        self,
        msg: TranscribeRequest,
        audio_path: str,
        initial_prompt: str,
        *,
        job_id_suffix: str = "",
    ):
        """Submit a single Job through the scheduler and await the result.

        For dual-track we submit two jobs sequentially so they share the
        background slot's priority queue with everything else. A unique
        suffix avoids `_all_jobs` key collisions when both halves share the
        same parent job_id.
        """
        job = Job(
            job_id=msg.job_id + job_id_suffix,
            kind=msg.kind,
            engine=msg.engine,
            language=msg.language,
            audio_path=audio_path,
            initial_prompt=initial_prompt,
            session_id=msg.session_id,
            meeting_title=msg.meeting_title,
        )
        fut = await self.scheduler.submit(job)
        return await fut

    async def _on_cancel(self, msg: CancelRequest, writer):
        # Dual-track transcribe (Phase 3) submits two scheduler Jobs keyed
        # `<job_id>:mic` and `<job_id>:sys`. A client cancellation arrives
        # with just the parent job_id, so fan out across all known suffixes
        # to preserve the Phase 1 cancellation guarantee.
        cancelled_any = False
        for key in (msg.job_id, f"{msg.job_id}:mic", f"{msg.job_id}:sys"):
            if await self.scheduler.cancel(key):
                cancelled_any = True
        return OkResponse(detail="cancelled" if cancelled_any else "not_found")

    def _resolve_realtime_engine(self, engine: str) -> str:
        """Pick the engine the LIVE tail should run. The live tail must keep up
        with wall-clock audio, so it uses the fast realtime backend when one is
        registered (e.g. "mlx" -> "mlx-realtime"). The FINAL pass still uses the
        requested `engine`. Falls back to `engine` when no realtime variant
        exists (e.g. whisper-cli, or a test app with only one backend)."""
        candidate = f"{engine}-realtime"
        if candidate in self.runtime.backends:
            return candidate
        return engine

    async def _on_subscribe_session(self, msg: SubscribeSessionRequest, writer):
        # Classify the mic WAV so a Phase-3 dual-track recording is read with
        # stride extraction (L=mic, R=sys interleaved Int16 at 48 kHz). Without
        # this branch the tail loop would feed whisper raw interleaved bytes
        # and produce hallucinated boilerplate captions.
        try:
            layout = classify(Path(msg.mic_path))
        except (FileNotFoundError, OSError, ValueError):
            layout = WavLayout.MONO

        realtime_engine = self._resolve_realtime_engine(msg.engine)
        chunk_max_sec = self.config.live_chunk_max_sec

        if layout is WavLayout.DUAL_TRACK:
            spec = LiveSession(
                sid=msg.sid,
                mic_path=msg.mic_path,
                sys_path=msg.mic_path,  # stride-extracted from the same file
                engine=msg.engine,
                language=msg.language,
                chunk_sec=msg.chunk_sec,
                mic_stride_offset=0,
                sys_stride_offset=2,
                stride_step=4,
                source_sample_rate_hz=48000,
                wav_header_bytes=82,
                realtime_engine=realtime_engine,
                chunk_max_sec=chunk_max_sec,
            )
        else:
            # MONO and LEGACY_STEREO both keep Phase-1 defaults (16 kHz / 44-byte
            # header / no stride). Legacy stereo is downmixed at final-transcribe
            # time, not in the live tail.
            spec = LiveSession(
                sid=msg.sid,
                mic_path=msg.mic_path,
                sys_path=msg.sys_path,
                engine=msg.engine,
                language=msg.language,
                chunk_sec=msg.chunk_sec,
                realtime_engine=realtime_engine,
                chunk_max_sec=chunk_max_sec,
            )
        await self.live_sessions.start_session(spec)
        self._subscribers.setdefault(msg.sid, []).append(writer)
        self.logger.info(
            "session_subscribed",
            sid=msg.sid,
            mic=msg.mic_path,
            layout=layout.value,
        )
        return OkResponse(detail=f"subscribed:{msg.sid}")

    async def _on_unsubscribe_session(self, msg: UnsubscribeSessionRequest, writer):
        fut = await self.live_sessions.stop_session(msg.sid, reason=msg.reason)
        subscribers = self._subscribers.pop(msg.sid, [])
        if fut is not None:
            asyncio.create_task(self._announce_final_when_ready(msg.sid, fut, subscribers))
        return OkResponse(detail=f"unsubscribed:{msg.sid}")

    async def _broadcast_partial(self, event) -> None:
        subscribers = self._subscribers.get(event.sid, [])
        if not subscribers:
            return
        from .protocol import encode
        payload = encode(event).encode()
        for writer in list(subscribers):
            if writer.is_closing():
                subscribers.remove(writer)
                continue
            try:
                writer.write(payload)
                await writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                subscribers.remove(writer)

    async def _announce_final_when_ready(self, sid, fut, subscribers) -> None:
        from .protocol import FinalReadyEvent, encode
        try:
            result = await fut
        except (asyncio.CancelledError, Exception) as exc:
            self.logger.warn("final_transcribe_failed_after_session_stop", sid=sid, err=str(exc))
            return
        active_paths = self._session_artifact_paths(sid, result)
        if active_paths is None:
            return
        transcript_path, raw_path = active_paths
        evt = FinalReadyEvent(
            sid=sid,
            transcript_path=str(transcript_path),
            raw_path=str(raw_path),
            engine=result.language or "",
            duration_ms=result.duration_ms,
        )
        payload = encode(evt).encode()
        for writer in subscribers:
            if writer.is_closing():
                continue
            try:
                writer.write(payload)
                await writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                continue

    def _session_artifact_paths(self, sid, result):
        artifact_dir = self.config.sessions_dir / sid
        artifact_dir.mkdir(parents=True, exist_ok=True)
        transcript_path = artifact_dir / "final.transcript.txt"
        raw_path = artifact_dir / "final.raw.transcript.txt"
        transcript_path.write_text(result.text or "", encoding="utf-8")
        raw_path.write_text(result.raw_text or "", encoding="utf-8")
        return transcript_path, raw_path

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
            except (NotImplementedError, RuntimeError):
                # RuntimeError is raised when not in the main thread (e.g. tests).
                pass
        try:
            loop.add_signal_handler(signal.SIGHUP, self._on_sighup)
        except (NotImplementedError, RuntimeError):
            pass

    def _on_sighup(self) -> None:
        self.vocab_cache.reload()
        self.logger.info("vocab_reloaded_via_sighup",
                          terms=len(self.vocab_cache.prompt_terms),
                          rules=len(self.vocab_cache.replace_rules))

    async def _handle_signal(self, sig) -> None:
        self.logger.info("signal_received", sig=int(sig))
        await self.stop()
