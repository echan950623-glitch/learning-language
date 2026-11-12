import { LEVEL_CHOICES, type LevelChoice } from "@/domain/jlptLevels";

/** Which levels self-directed review draws from. A per-device choice, like the appearance setting. */
const STORAGE_KEY = "learning-language:review-levels:v1";
const listeners = new Set<() => void>();

export function readLevelFilter(): LevelChoice[] {
  if (typeof window === "undefined") return [];
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) ? LEVEL_CHOICES.filter(level => saved.includes(level)) : [];
  } catch {
    return [];
  }
}

export function saveLevelFilter(levels: readonly LevelChoice[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(LEVEL_CHOICES.filter(level => levels.includes(level))));
  } catch {
    // The choice still applies to this page; it just will not survive a reload.
  }
  listeners.forEach(listener => listener());
}

export function subscribeLevelFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
