"use client";
import { useEffect } from "react";
import { applyTheme, readTheme } from "@/lib/themePreference";

/** Applies the saved appearance after load; dark is the default, so only the light choice needs this. */
export function ThemePreference() {
  useEffect(() => { applyTheme(readTheme()); }, []);
  return null;
}
