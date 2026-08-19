import type { RealtimeItem } from "@openai/agents/realtime";
import { z } from "zod";

import type { VerifiedSessionInfo } from "./types";

const geminiReadySchema = z
  .object({
    type: z.literal("ready"),
    provider: z.literal("gemini"),
    model: z.string().min(1).max(200),
    voice: z.string().min(1).max(64),
    input_sample_rate: z.literal(16000),
    output_sample_rate: z.literal(24000),
    agent_runtime: z.literal("google-adk"),
  })
  .strict();

const geminiCaptionSchema = z
  .object({
    type: z.literal("caption"),
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(16_000),
    item_id: z.string().min(1).max(256),
    final: z.boolean().optional(),
    mode: z.enum(["append", "replace"]).optional(),
  })
  .strict();

const geminiControlSchema = z.discriminatedUnion("type", [
  geminiReadySchema,
  geminiCaptionSchema,
  z
    .object({
      type: z.literal("interrupted"),
      item_id: z.string().min(1).max(256),
    })
    .strict(),
  z.object({ type: z.literal("turn_complete") }).strict(),
  z
    .object({
      type: z.literal("tool_activity"),
      kind: z.enum(["call", "return"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("endpoint"),
      kind: z.enum(["speech-start", "speech-end"]),
    })
    .strict(),
  z
    .object({ type: z.literal("error"), message: z.string().min(1).max(1_024).optional() })
    .strict(),
]);

export type GeminiReadyMessage = z.infer<typeof geminiReadySchema>;
export type GeminiCaptionMessage = z.infer<typeof geminiCaptionSchema>;
export type GeminiControlMessage = z.infer<typeof geminiControlSchema>;

export function parseGeminiControlMessage(value: string): GeminiControlMessage | null {
  try {
    const parsed: unknown = JSON.parse(value);
    const result = geminiControlSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function validateGeminiReady(
  message: GeminiReadyMessage,
  voice: string,
): VerifiedSessionInfo {
  if (
    message.provider !== "gemini" ||
    !message.model ||
    message.voice !== voice ||
    message.input_sample_rate !== 16000 ||
    message.output_sample_rate !== 24000 ||
    message.agent_runtime !== "google-adk"
  ) {
    throw new Error("The Gemini ADK gateway returned an invalid session acknowledgement.");
  }
  return {
    provider: "gemini",
    model: message.model,
    voice,
    transport: "websocket",
    agentRuntime: "google-adk",
  };
}

export interface OpenAISessionAcknowledgement {
  model: string;
  voice: string;
}

export function validateOpenAISessionAcknowledgement(
  event: unknown,
  expectedModel: string,
  expectedVoice: string,
): OpenAISessionAcknowledgement {
  const parsed = z
    .object({
      type: z.literal("session.updated"),
      session: z
        .object({
          model: z.string(),
          voice: z.string().optional(),
          audio: z
            .object({
              output: z.object({ voice: z.string().optional() }).passthrough().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    })
    .passthrough()
    .safeParse(event);
  const voice = parsed.success
    ? (parsed.data.session.audio?.output?.voice ?? parsed.data.session.voice)
    : undefined;
  if (!parsed.success || parsed.data.session.model !== expectedModel || voice !== expectedVoice) {
    throw new Error("OpenAI acknowledged an unexpected model or voice.");
  }
  return { model: parsed.data.session.model, voice };
}

export function transcriptFromOpenAIItem(item: RealtimeItem): string {
  if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) return "";
  return item.content
    .map((part) => {
      if (part.type === "input_text" || part.type === "output_text") return part.text ?? "";
      if (part.type === "input_audio" || part.type === "output_audio") {
        return part.transcript ?? "";
      }
      return "";
    })
    .join("")
    .trim();
}
