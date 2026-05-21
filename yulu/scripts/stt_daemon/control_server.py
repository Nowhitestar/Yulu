"""Asyncio Unix-socket server: routes incoming lines to handlers."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Awaitable, Callable, Optional

from .logging import JsonLogger
from .protocol import (
    HealthRequest, WarmUpRequest, VocabReloadRequest,
    TranscribeRequest, CancelRequest,
    SubscribeSessionRequest, UnsubscribeSessionRequest,
    decode, encode,
)


HandlerResult = Awaitable[Optional[object]]
Handler = Callable[[object, asyncio.StreamWriter], HandlerResult]


class ControlServer:
    def __init__(
        self,
        *,
        socket_path: Path,
        logger: JsonLogger,
        max_connections: int = 100,
    ):
        self.socket_path = Path(socket_path)
        self.logger = logger
        self.max_connections = max_connections
        self._handlers: dict[type, Handler] = {}
        self._server: Optional[asyncio.AbstractServer] = None
        self._active = 0

    def register(self, msg_cls: type, handler: Handler) -> None:
        self._handlers[msg_cls] = handler

    async def start(self) -> None:
        if self.socket_path.exists():
            self.socket_path.unlink()
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        self._server = await asyncio.start_unix_server(
            self._handle_client, path=str(self.socket_path)
        )
        self.logger.info("control_server_started", path=str(self.socket_path))

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        if self.socket_path.exists():
            try:
                self.socket_path.unlink()
            except OSError:
                pass

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        if self._active >= self.max_connections:
            self.logger.warn("connection_rejected", active=self._active)
            writer.close()
            return
        self._active += 1
        try:
            while True:
                line = await reader.readline()
                if not line:
                    return
                try:
                    msg = decode(line.decode().strip())
                except ValueError as exc:
                    from .protocol import ErrorEvent, ErrorCode
                    writer.write(encode(ErrorEvent(
                        code=ErrorCode.INTERNAL,
                        message=f"decode error: {exc}",
                    )).encode())
                    await writer.drain()
                    continue

                handler = self._handlers.get(type(msg))
                if handler is None:
                    from .protocol import ErrorEvent, ErrorCode
                    writer.write(encode(ErrorEvent(
                        code=ErrorCode.INTERNAL,
                        message=f"no handler for {type(msg).__name__}",
                    )).encode())
                    await writer.drain()
                    continue

                try:
                    response = await handler(msg, writer)
                except Exception as exc:
                    self.logger.error("handler_failed", error=str(exc), type=type(msg).__name__)
                    from .protocol import ErrorEvent, ErrorCode
                    response = ErrorEvent(code=ErrorCode.INTERNAL, message=str(exc))

                if response is not None:
                    writer.write(encode(response).encode())
                    await writer.drain()
        finally:
            self._active -= 1
            try:
                writer.close()
                await writer.wait_closed()
            except (ConnectionResetError, BrokenPipeError):
                pass
