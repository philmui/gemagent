.PHONY: sync serve test

sync:
	uv sync --locked --extra dev

serve: sync
	uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

test: sync
	uv run pytest
