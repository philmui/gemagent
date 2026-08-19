import { describe, expect, it } from "vitest";

import { tabForKey } from "../src/lib/tab-navigation";

describe("side panel tab navigation", () => {
  it("moves and wraps with horizontal arrow keys", () => {
    expect(tabForKey("conversation", "ArrowRight")).toBe("settings");
    expect(tabForKey("settings", "ArrowRight")).toBe("conversation");
    expect(tabForKey("conversation", "ArrowLeft")).toBe("settings");
  });

  it("supports Home and End without consuming unrelated keys", () => {
    expect(tabForKey("settings", "Home")).toBe("conversation");
    expect(tabForKey("conversation", "End")).toBe("settings");
    expect(tabForKey("conversation", "Enter")).toBeNull();
  });
});
