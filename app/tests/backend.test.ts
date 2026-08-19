import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendError, searchOpenAIWeb } from "../src/lib/backend";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI web search backend client", () => {
  it("posts a bounded query and validates the public result", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answer: "Grounded answer",
          sources: [{ title: "Official", url: "https://example.test/source" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await expect(searchOpenAIWeb("current release", signal)).resolves.toEqual({
      answer: "Grounded answer",
      sources: [{ title: "Official", url: "https://example.test/source" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/tools/web-search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "current release" }),
        cache: "no-store",
        signal,
      }),
    );
  });

  it("fails closed on an invalid result shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ answer: "Missing sources" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      searchOpenAIWeb("current release", new AbortController().signal),
    ).rejects.toThrow(BackendError);
  });
});
