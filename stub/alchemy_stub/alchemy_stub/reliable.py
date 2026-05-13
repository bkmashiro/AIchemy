"""Reliable messaging layer for stub ↔ server socket.io communication.

Implements monotonic seq, outbox with retransmit, cumulative ack,
gap nack, and resume replay — matching the server's reliable.ts.

Transport events:
  r       → carry ReliableMessage
  r.ack   → cumulative ack  { seq }
  r.nack  → gap request     { from, to }
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

log = logging.getLogger(__name__)


@dataclass
class ReliableMessage:
    seq: int
    event: str
    payload: Any
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "seq": self.seq,
            "event": self.event,
            "payload": self.payload,
            "ts": int(self.ts * 1000),
        }

    @staticmethod
    def from_dict(d: dict) -> "ReliableMessage":
        return ReliableMessage(
            seq=d["seq"],
            event=d["event"],
            payload=d["payload"],
            ts=d.get("ts", time.time() * 1000) / 1000,
        )


class ReliableEmitter:
    """Sends messages with monotonic seq; retransmits on nack; prunes on ack.

    Usage:
        emitter = ReliableEmitter(raw_emit_fn)
        await emitter.emit("task.started", {...})
        emitter.on_ack(ack_seq)
        emitter.on_nack(from_seq, to_seq)
        emitter.on_resume(last_seq)  # replay outbox on reconnect
    """

    RETRY_INTERVAL = 5.0  # seconds between automatic retries

    def __init__(self, raw_emit: Callable[[str, Any], Awaitable[None]]):
        self._raw_emit = raw_emit
        self._seq = 0
        self._outbox: list[ReliableMessage] = []
        self._retry_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    async def emit(self, event: str, payload: Any) -> None:
        async with self._lock:
            self._seq += 1
            msg = ReliableMessage(seq=self._seq, event=event, payload=payload)
            self._outbox.append(msg)
        await self._raw_emit("r", msg.to_dict())
        self._ensure_retry_task()

    def on_ack(self, ack_seq: int) -> None:
        self._outbox = [m for m in self._outbox if m.seq > ack_seq]

    def on_nack(self, from_seq: int, to_seq: int) -> None:
        """Server requested retransmit of [from_seq, to_seq]."""
        asyncio.create_task(self._retransmit_range(from_seq, to_seq))

    async def _retransmit_range(self, from_seq: int, to_seq: int) -> None:
        for msg in self._outbox:
            if from_seq <= msg.seq <= to_seq:
                try:
                    await self._raw_emit("r", msg.to_dict())
                except Exception as e:
                    log.warning("retransmit failed: %s", e)

    async def on_resume(self, last_seq: int) -> None:
        """Replay all outbox messages after last_seq (server reconnected)."""
        to_replay = [m for m in self._outbox if m.seq > last_seq]
        for msg in to_replay:
            try:
                await self._raw_emit("r", msg.to_dict())
            except Exception as e:
                log.warning("resume replay failed: %s", e)

    def _ensure_retry_task(self) -> None:
        if self._retry_task is None or self._retry_task.done():
            self._retry_task = asyncio.create_task(self._retry_loop())

    async def _retry_loop(self) -> None:
        """Periodically retransmit outbox items that haven't been acked."""
        while self._outbox:
            await asyncio.sleep(self.RETRY_INTERVAL)
            for msg in list(self._outbox):
                try:
                    await self._raw_emit("r", msg.to_dict())
                except Exception as e:
                    log.warning("retry emit failed: %s", e)

    @property
    def last_seq(self) -> int:
        return self._seq


class ReliableReceiver:
    """Receives reliable messages; deduplicates; delivers in-order; acks.

    Usage:
        receiver = ReliableReceiver(raw_emit_fn, deliver_fn)
        await receiver.on_message(raw_dict)
    """

    def __init__(
        self,
        raw_emit: Callable[[str, Any], Awaitable[None]],
        deliver: Callable[[str, Any], Awaitable[None]],
    ):
        self._raw_emit = raw_emit
        self._deliver = deliver
        self._last_seq = 0
        self._pending: dict[int, ReliableMessage] = {}

    async def on_message(self, data: dict) -> None:
        msg = ReliableMessage.from_dict(data)

        if msg.seq <= self._last_seq:
            # Duplicate — re-ack and discard
            await self._send_ack(self._last_seq)
            return

        if msg.seq == self._last_seq + 1:
            await self._deliver(msg.event, msg.payload)
            self._last_seq = msg.seq

            # Drain any buffered in-order messages
            while self._last_seq + 1 in self._pending:
                nxt = self._pending.pop(self._last_seq + 1)
                await self._deliver(nxt.event, nxt.payload)
                self._last_seq = nxt.seq

            await self._send_ack(self._last_seq)
        else:
            # Out-of-order: buffer and request gap
            self._pending[msg.seq] = msg
            await self._send_nack(self._last_seq + 1, msg.seq - 1)

    async def _send_ack(self, seq: int) -> None:
        try:
            await self._raw_emit("r.ack", {"seq": seq})
        except Exception as e:
            log.warning("ack send failed: %s", e)

    async def _send_nack(self, from_seq: int, to_seq: int) -> None:
        try:
            await self._raw_emit("r.nack", {"from": from_seq, "to": to_seq})
        except Exception as e:
            log.warning("nack send failed: %s", e)

    @property
    def last_seq(self) -> int:
        return self._last_seq
