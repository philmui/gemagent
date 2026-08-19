"use client";

import { useCallback, useRef, useSyncExternalStore, type KeyboardEvent } from "react";

import {
  THEME_META_COLORS,
  THEME_STORAGE_KEY,
  THEMES,
  isTheme,
  themeForKey,
  type Theme,
} from "@/lib/theme";
import { BookIcon, MoonIcon, SunIcon } from "./icons";

const THEME_LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  study: "Study",
};

const THEME_ICONS = {
  light: SunIcon,
  dark: MoonIcon,
  study: BookIcon,
} satisfies Record<Theme, typeof SunIcon>;

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_META_COLORS[theme]);
}

const THEME_CHANGE_EVENT = "voice-lab-theme-change";

function currentTheme(): Theme {
  const documentTheme = document.documentElement.dataset.theme;
  return isTheme(documentTheme) ? documentTheme : "dark";
}

function subscribeToTheme(onChange: () => void) {
  const syncAcrossTabs = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY || !isTheme(event.newValue)) return;
    applyTheme(event.newValue);
    onChange();
  };
  window.addEventListener("storage", syncAcrossTabs);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", syncAcrossTabs);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  };
}

export function ThemeToggle() {
  const theme = useSyncExternalStore<Theme>(subscribeToTheme, currentTheme, () => "dark");
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTheme = useCallback((nextTheme: Theme) => {
    applyTheme(nextTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The visual selection still works when storage is unavailable.
    }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const nextTheme = themeForKey(theme, event.key);
    if (!nextTheme) return;
    event.preventDefault();
    selectTheme(nextTheme);
    const nextIndex = THEMES.indexOf(nextTheme);
    buttonRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Color scheme">
      {THEMES.map((option, index) => {
        const Icon = THEME_ICONS[option];
        const selected = theme === option;
        return (
          <button
            ref={(button) => { buttonRefs.current[index] = button; }}
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`Use ${THEME_LABELS[option].toLowerCase()} color scheme`}
            title={`${THEME_LABELS[option]} color scheme`}
            tabIndex={selected ? 0 : -1}
            className={`theme-option theme-option-${option}`}
            onClick={() => selectTheme(option)}
            onKeyDown={handleKeyDown}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
