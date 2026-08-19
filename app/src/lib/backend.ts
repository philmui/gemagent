import type { BackendHealth, SessionCredential } from "./types";
import { z } from "zod";

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8000";

function backendUrl(): string {
  return (process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/$/, "");
}

export function geminiLiveWebSocketUrl(voice: string): string {
  const url = new URL(`${backendUrl()}/api/live/gemini`);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new BackendError("NEXT_PUBLIC_BACKEND_URL must use HTTP or HTTPS.");
  url.searchParams.set("voice", voice);
  return url.toString();
}

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

function friendlyBackendError(status: number): string {
  if (status === 401 || status === 403) {
    return "This provider is not authorized. Check the backend key and allowed browser origin.";
  }
  if (status === 409) {
    return "The session service is busy. Wait a moment, then try again.";
  }
  if (status === 429) {
    return "The session limit was reached. Wait a minute, then try again.";
  }
  if (status >= 500) {
    return "The provider could not start a session. Check the backend logs and provider status.";
  }
  return "The session request was rejected. Check the selected provider and voice.";
}

const healthSchema = z
  .object({
    status: z.literal("ok"),
    providers: z
      .object({
        gemini: z
          .object({
            configured: z.boolean(),
            model: z.string().min(1).max(200),
            runtime: z.literal("google-adk"),
          })
          .strict(),
        openai: z
          .object({
            configured: z.boolean(),
            model: z.string().min(1).max(200),
            runtime: z.literal("openai-agents-sdk"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const credentialSchema = z
  .object({
    provider: z.literal("openai"),
    token: z.string().min(1),
    expires_at: z.string().min(1),
    model: z.string().min(1).max(200),
    transport: z.object({ type: z.literal("webrtc"), url: z.url() }).strict(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

const webSearchSchema = z
  .object({
    answer: z.string().min(1).max(12_000),
    sources: z
      .array(
        z
          .object({
            title: z.string().min(1).max(300),
            url: z.url().max(2_048),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export async function fetchHealth(signal?: AbortSignal): Promise<BackendHealth> {
  let response: Response;
  try {
    response = await fetch(`${backendUrl()}/health`, { signal, cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new BackendError(
      "The backend is unreachable. Start FastAPI on port 8000 and check NEXT_PUBLIC_BACKEND_URL.",
    );
  }
  if (!response.ok) throw new BackendError("The backend health check failed.", response.status);
  const parsed = healthSchema.safeParse(await response.json());
  if (!parsed.success) throw new BackendError("The backend returned an unexpected health response.");
  return parsed.data;
}

export async function mintOpenAISessionCredential(
  voice: string,
  signal: AbortSignal,
): Promise<SessionCredential> {
  let response: Response;
  try {
    response = await fetch(`${backendUrl()}/api/session-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", voice }),
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new BackendError(
      "The backend is unreachable. Start FastAPI on port 8000 and check NEXT_PUBLIC_BACKEND_URL.",
    );
  }

  if (!response.ok) throw new BackendError(friendlyBackendError(response.status), response.status);
  const parsed = credentialSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new BackendError("The backend returned an invalid session credential.");
  }
  return parsed.data as SessionCredential;
}

export async function searchOpenAIWeb(
  query: string,
  signal: AbortSignal,
): Promise<z.infer<typeof webSearchSchema>> {
  let response: Response;
  try {
    response = await fetch(`${backendUrl()}/api/tools/web-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new BackendError("Web search could not reach the backend.");
  }

  if (!response.ok) {
    const message =
      response.status === 429
        ? "Web search is busy. Try again shortly."
        : "Web search is temporarily unavailable.";
    throw new BackendError(message, response.status);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new BackendError("The backend returned an invalid search result.");
  }
  const parsed = webSearchSchema.safeParse(data);
  if (!parsed.success) throw new BackendError("The backend returned an invalid search result.");
  return parsed.data;
}
