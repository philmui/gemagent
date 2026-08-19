import { describe, expect, it } from "vitest";

import { scrollConversationToLatest } from "../src/lib/conversation-scroll";

describe("conversation auto-scroll", () => {
  it("moves only the transcript container to its newest content", () => {
    const transcript = { scrollTop: 24, scrollHeight: 1_280 };

    scrollConversationToLatest(transcript);

    expect(transcript.scrollTop).toBe(1_280);
  });

  it("tolerates an unavailable transcript during tab transitions", () => {
    expect(() => scrollConversationToLatest(null)).not.toThrow();
  });
});
