"use client";

import { useSyncExternalStore } from "react";
import type { Language } from "@/domain/types";

const STORAGE_KEY = "learning-language:home-language:v1";
const CHANGE_EVENT = "learning-language:home-language-changed";
let fallbackLanguage: Language = "ja";

function readLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "ja" || stored === "en") return stored;
  } catch {
    // Switching still works for this visit when browser storage is unavailable.
  }
  return fallbackLanguage;
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function selectHomeLanguage(language: Language) {
  fallbackLanguage = language;
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // This preference does not affect learning records or cloud sync.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useHomeLanguage(): Language {
  return useSyncExternalStore(subscribe, readLanguage, () => "ja");
}
