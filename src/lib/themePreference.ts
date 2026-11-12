/** Appearance is a per-device choice, so it stays out of the synced account data. */
export type ThemeChoice = "dark" | "light";
const STORAGE_KEY = "learning-language:theme:v1";
const listeners = new Set<() => void>();

export function readTheme(): ThemeChoice {
  if (typeof window === "undefined") return "dark";
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: ThemeChoice): void {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f5f1" : "#100f0d");
}

export function saveTheme(theme: ThemeChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The choice still applies to this page; it just will not survive a reload.
  }
  applyTheme(theme);
  listeners.forEach(listener => listener());
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
