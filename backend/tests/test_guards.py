from __future__ import annotations

import asyncio

import pytest

from app.guards import (
    ConcurrencyGuard,
    ConcurrencyLimitExceeded,
    RateLimitExceeded,
    SlidingWindowRateLimiter,
)


@pytest.mark.asyncio
async def test_sliding_window_limit_and_expiry() -> None:
    now = 10.0
    limiter = SlidingWindowRateLimiter(2, window_seconds=60, clock=lambda: now)

    await limiter.check("client")
    await limiter.check("client")
    with pytest.raises(RateLimitExceeded):
        await limiter.check("client")

    now = 71.0
    await limiter.check("client")


@pytest.mark.asyncio
async def test_concurrency_guard_fails_fast_and_releases() -> None:
    guard = ConcurrencyGuard(1)
    entered = asyncio.Event()
    release = asyncio.Event()

    async def hold_slot() -> None:
        async with guard.slot():
            entered.set()
            await release.wait()

    task = asyncio.create_task(hold_slot())
    await entered.wait()
    with pytest.raises(ConcurrencyLimitExceeded):
        async with guard.slot():
            pass
    release.set()
    await task

    async with guard.slot():
        pass
