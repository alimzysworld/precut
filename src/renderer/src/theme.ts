export type ThemeChoice = "light" | "dark" | "system";
export type BadgeTone = "lime" | "amber" | "pink" | "violet" | "neutral";

const THEME_KEY = "st-footage.theme";
let sessionTheme: ThemeChoice | undefined;

export const badgeTokens: Record<BadgeTone, { fill: string; ink: string }> = {
  lime: { fill: "--badge-lime-fill", ink: "--badge-lime-ink" },
  amber: { fill: "--badge-amber-fill", ink: "--badge-amber-ink" },
  pink: { fill: "--badge-pink-fill", ink: "--badge-pink-ink" },
  violet: { fill: "--badge-violet-fill", ink: "--badge-violet-ink" },
  neutral: { fill: "--badge-neutral-fill", ink: "--badge-neutral-ink" },
};

export function storedTheme(): ThemeChoice {
  if (sessionTheme) return sessionTheme;
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch { /* storage unavailable */ }
  return "system";
}

function paintTheme(choice: ThemeChoice): void {
  const resolved = choice === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : choice;
  const root = document.documentElement;
  root.dataset.appearance = "indie";
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // Read the palette itself so browser chrome and native vibrancy stay in step.
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content", getComputedStyle(root).getPropertyValue("--ground").trim(),
  );
}

export function applyTheme(choice: ThemeChoice): void {
  sessionTheme = choice;
  try { window.localStorage.setItem(THEME_KEY, choice); } catch { /* storage unavailable */ }
  paintTheme(choice);
}

// The HTML bootstrap already resolves light/dark before CSS. Apply the palette
// synchronously while importing App, before React can paint any content.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  paintTheme(storedTheme());
}
