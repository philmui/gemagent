import { describe, expect, it } from "vitest";

import { defaultTheme, isTheme, resolveTheme, themeForKey, THEMES } from "../src/lib/theme";

describe("color scheme preferences", () => {
  it("offers the three supported schemes in control order", () => {
    expect(THEMES).toEqual(["light", "dark", "study"]);
    expect(THEMES.every(isTheme)).toBe(true);
  });

  it("preserves a valid stored preference", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("study", false)).toBe("study");
  });

  it("uses the operating system preference when storage is absent or invalid", () => {
    expect(defaultTheme(true)).toBe("light");
    expect(defaultTheme(false)).toBe("dark");
    expect(resolveTheme(null, true)).toBe("light");
    expect(resolveTheme("sepia", false)).toBe("dark");
  });

  it("moves and wraps with radio-group keyboard controls", () => {
    expect(themeForKey("light", "ArrowRight")).toBe("dark");
    expect(themeForKey("study", "ArrowRight")).toBe("light");
    expect(themeForKey("light", "ArrowLeft")).toBe("study");
    expect(themeForKey("dark", "Home")).toBe("light");
    expect(themeForKey("dark", "End")).toBe("study");
    expect(themeForKey("dark", "Enter")).toBeNull();
  });
});
