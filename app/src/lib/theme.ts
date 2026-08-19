export const THEME_STORAGE_KEY = "voice-lab-color-scheme";

export const THEMES = ["light", "dark", "study"] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_META_COLORS: Record<Theme, string> = {
  light: "#f3f6fb",
  dark: "#080a10",
  study: "#f3eddf",
};

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && THEMES.includes(value as Theme);
}

export function defaultTheme(prefersLight: boolean): Theme {
  return prefersLight ? "light" : "dark";
}

export function resolveTheme(stored: unknown, prefersLight: boolean): Theme {
  return isTheme(stored) ? stored : defaultTheme(prefersLight);
}

export function themeForKey(current: Theme, key: string): Theme | null {
  const index = THEMES.indexOf(current);
  if (key === "ArrowRight" || key === "ArrowDown") return THEMES[(index + 1) % THEMES.length] ?? null;
  if (key === "ArrowLeft" || key === "ArrowUp") return THEMES[(index - 1 + THEMES.length) % THEMES.length] ?? null;
  if (key === "Home") return THEMES[0];
  if (key === "End") return THEMES.at(-1) ?? null;
  return null;
}

// Runs before paint so returning visitors do not see the dark default flash.
export const THEME_BOOTSTRAP_SCRIPT = `(() => {
  let stored = null;
  try { stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}); } catch {}
  const valid = stored === "light" || stored === "dark" || stored === "study";
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  const theme = valid ? stored : (prefersLight ? "light" : "dark");
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "study" ? "#f3eddf" : theme === "light" ? "#f3f6fb" : "#080a10");
})();`;
