FROM ghcr.io/astral-sh/uv:0.11.23 AS uv

FROM python:3.13-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH=/service/backend/.venv/bin:$PATH \
    PORT=8080

COPY --from=uv /uv /uvx /bin/

WORKDIR /service/backend

# Resolve only from the reviewed lockfile. Keep dependency installation in a
# cacheable layer, then install the backend itself after its source is present.
COPY backend/pyproject.toml backend/uv.lock backend/README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/app ./app
RUN uv sync --frozen --no-dev --no-editable

# The application needs no writable project files. Cloud Run supplies /tmp.
USER 65532:65532

EXPOSE 8080

# One process keeps the demonstration's in-memory limits coherent. Cloud Run
# adds instances according to the configured scaling limits.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-8080}\" --workers 1 --ws-max-size 65536 --ws-max-queue 16 --ws-per-message-deflate false"]
