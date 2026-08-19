import type { RealtimeItem } from "@openai/agents/realtime";
import { describe, expect, it } from "vitest";

import {
  CLIENT_PROTOCOL_ERROR_CLOSE_CODE,
  GEMINI_SETUP_TIMEOUT_MS,
} from "../src/lib/gemini-adapter";
import {
  parseGeminiControlMessage,
  transcriptFromOpenAIItem,
  validateGeminiReady,
  validateOpenAISessionAcknowledgement,
} from "../src/lib/provider-protocol";

describe("Gemini ADK browser protocol", () => {
  const ready = {
    type: "ready" as const,
    provider: "gemini" as const,
    model: "gemini-live-2.5-flash-native-audio",
    voice: "Kore",
    input_sample_rate: 16000 as const,
    output_sample_rate: 24000 as const,
    agent_runtime: "google-adk" as const,
  };

  it("uses a browser-permitted application close code for client protocol failures", () => {
    expect(CLIENT_PROTOCOL_ERROR_CLOSE_CODE).toBeGreaterThanOrEqual(3000);
    expect(CLIENT_PROTOCOL_ERROR_CLOSE_CODE).toBeLessThanOrEqual(4999);
  });

  it("allows more setup time than the backend upstream deadline", () => {
    expect(GEMINI_SETUP_TIMEOUT_MS).toBeGreaterThan(15_000);
  });

  it("accepts the exact server-owned model and audio contract", () => {
    expect(validateGeminiReady(ready, "Kore")).toEqual({
      provider: "gemini",
      model: "gemini-live-2.5-flash-native-audio",
      voice: "Kore",
      transport: "websocket",
      agentRuntime: "google-adk",
    });
  });

  it("rejects a voice mismatch and malformed JSON", () => {
    expect(() => validateGeminiReady(ready, "Puck")).toThrow(/invalid session/i);
    expect(parseGeminiControlMessage("not json")).toBeNull();
  });

  it("rejects malformed or unexpected control fields", () => {
    expect(parseGeminiControlMessage(JSON.stringify({ type: "caption", role: "tool" }))).toBeNull();
    expect(
      parseGeminiControlMessage(JSON.stringify({ type: "turn_complete", secret: "leak" })),
    ).toBeNull();
    expect(
      parseGeminiControlMessage(
        JSON.stringify({
          type: "caption",
          role: "assistant",
          text: "Hello",
          item_id: "assistant-1",
          mode: "append",
        }),
      ),
    ).toMatchObject({ type: "caption", role: "assistant", text: "Hello" });
  });

  it("accepts a sanitized setup error before a ready acknowledgement", () => {
    expect(
      parseGeminiControlMessage(
        JSON.stringify({ type: "error", message: "Gemini Live could not continue this session." }),
      ),
    ).toEqual({ type: "error", message: "Gemini Live could not continue this session." });
  });

  it("requires an exact assistant item ID on interruption controls", () => {
    expect(
      parseGeminiControlMessage(
        JSON.stringify({ type: "interrupted", item_id: "gemini-assistant-3" }),
      ),
    ).toEqual({ type: "interrupted", item_id: "gemini-assistant-3" });
    expect(parseGeminiControlMessage(JSON.stringify({ type: "interrupted" }))).toBeNull();
  });

  it("accepts only sanitized endpoint and tool activity controls", () => {
    expect(parseGeminiControlMessage(JSON.stringify({ type: "endpoint", kind: "speech-end" })))
      .toEqual({ type: "endpoint", kind: "speech-end" });
    expect(parseGeminiControlMessage(JSON.stringify({ type: "tool_activity", kind: "call" })))
      .toEqual({ type: "tool_activity", kind: "call" });
    expect(
      parseGeminiControlMessage(
        JSON.stringify({ type: "tool_activity", kind: "return", result: "private" }),
      ),
    ).toBeNull();
  });
});

describe("OpenAI Agents SDK history", () => {
  it("requires the provider to acknowledge the requested model and voice", () => {
    const event = {
      type: "session.updated",
      event_id: "event-1",
      session: {
        model: "gpt-realtime-2.1",
        audio: { output: { voice: "marin" } },
      },
    };
    expect(validateOpenAISessionAcknowledgement(event, "gpt-realtime-2.1", "marin")).toEqual({
      model: "gpt-realtime-2.1",
      voice: "marin",
    });
    expect(() =>
      validateOpenAISessionAcknowledgement(event, "gpt-realtime-2.1", "cedar"),
    ).toThrow(/unexpected model or voice/i);
  });

  it("extracts user and assistant audio transcripts", () => {
    const user = {
      itemId: "user-1",
      type: "message",
      role: "user",
      status: "completed",
      content: [{ type: "input_audio", audio: null, transcript: "Hello there" }],
    } as RealtimeItem;
    const assistant = {
      itemId: "assistant-1",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [{ type: "output_audio", audio: null, transcript: "Hi back" }],
    } as RealtimeItem;

    expect(transcriptFromOpenAIItem(user)).toBe("Hello there");
    expect(transcriptFromOpenAIItem(assistant)).toBe("Hi back");
  });

  it("does not expose tool payloads as conversation captions", () => {
    const tool = {
      itemId: "tool-1",
      type: "function_call",
      status: "completed",
      name: "private_tool",
      arguments: '{"secret":"value"}',
      output: "private output",
    } as RealtimeItem;

    expect(transcriptFromOpenAIItem(tool)).toBe("");
  });
});
