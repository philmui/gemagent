"""Small in-memory abuse and overload guards.

These guards are intentionally process-local. Deployments with more than one
worker should put a distributed rate limiter or authenticated gateway in front
of this service.
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import AsyncIterator, Callable


class RateLimitExceeded(Exception):
    pass


class ConcurrencyLimitExceeded(Exception):
    pass


class SlidingWindowRateLimiter:
    def __init__(
        self,
        limit: int,
        *,
        window_seconds: float = 60.0,
        max_keys: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self._clock = clock
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def check(self, key: str) -> None:
        now = self._clock()
        threshold = now - self.window_seconds
        async with self._lock:
            if key not in self._events and len(self._events) >= self.max_keys:
                stale_keys = [
                    event_key
                    for event_key, event_times in self._events.items()
                    if not event_times or event_times[-1] <= threshold
                ]
                for stale_key in stale_keys:
                    del self._events[stale_key]
                if len(self._events) >= self.max_keys:
                    key = "__overflow__"
            events = self._events[key]
            while events and events[0] <= threshold:
                events.popleft()
            if len(events) >= self.limit:
                raise RateLimitExceeded
            events.append(now)


class ConcurrencyGuard:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self._active = 0
        self._lock = asyncio.Lock()

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        async with self._lock:
            if self._active >= self.limit:
                raise ConcurrencyLimitExceeded
            self._active += 1
        try:
            yield
        finally:
            async with self._lock:
                self._active -= 1
