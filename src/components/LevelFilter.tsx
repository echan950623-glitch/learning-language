"use client";
import { useEffect, useState } from "react";
import { LEVEL_CHOICES, LEVEL_LABELS, type LevelChoice } from "@/domain/jlptLevels";
import { readLevelFilter, saveLevelFilter, subscribeLevelFilter } from "@/lib/levelFilter";

/** The saved review levels; empty until read on the client, which also means "everything". */
export function useLevelFilter(): LevelChoice[] {
  const [levels, setLevels] = useState<LevelChoice[]>([]);
  useEffect(() => {
    const refresh = () => setLevels(readLevelFilter());
    refresh();
    return subscribeLevelFilter(refresh);
  }, []);
  return levels;
}

const chip = (active: boolean) => `min-h-10 rounded-full border px-4 text-sm transition-colors ${active ? "border-primary bg-primary font-semibold text-primary-foreground" : "border-border text-foreground-muted hover:text-foreground"}`;

export function LevelFilterChips() {
  const levels = useLevelFilter();
  const toggle = (level: LevelChoice) => saveLevelFilter(levels.includes(level) ? levels.filter(value => value !== level) : [...levels, level]);
  return (
    <div role="group" aria-label="複習級別" className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={levels.length === 0} onClick={() => saveLevelFilter([])} className={chip(levels.length === 0)}>全部</button>
      {LEVEL_CHOICES.map(level => (
        <button key={level} type="button" aria-pressed={levels.includes(level)} onClick={() => toggle(level)} className={chip(levels.includes(level))}>{LEVEL_LABELS[level]}</button>
      ))}
    </div>
  );
}
