/**
 * 範例種子資料：只在「本機從未有任何存檔」的真正第一次啟動時注入，
 * 方便第一次打開 App 與測試時有東西可看。全部標記 isSeed: true，
 * 使用者可在進度頁一次清除，不會被誤認成 AI 自動產生或使用者真實學習資料。
 */

import type { LearningItem } from "../domain/types";
import { generateId } from "../domain/id";

interface SeedDefinition {
  promptZh: string;
  answer: string;
  reading: string;
  explanation?: string;
  tags: string[];
}

const SEED_DEFINITIONS: SeedDefinition[] = [
  { promptZh: "你好", answer: "こんにちは", reading: "こんにちは", explanation: "日常問候語，用於白天見面時", tags: ["範例", "問候"] },
  { promptZh: "謝謝", answer: "ありがとう", reading: "ありがとう", tags: ["範例", "問候"] },
  { promptZh: "學生", answer: "学生", reading: "がくせい", explanation: "漢字讀音練習範例", tags: ["範例", "名詞"] },
  { promptZh: "吃", answer: "食べる", reading: "たべる", tags: ["範例", "動詞"] },
  { promptZh: "朋友", answer: "友達", reading: "ともだち", tags: ["範例", "名詞"] },
  { promptZh: "水", answer: "水", reading: "みず", tags: ["範例", "名詞"] },
];

export function buildSeedItems(now: Date): LearningItem[] {
  const createdAt = now.toISOString();
  return SEED_DEFINITIONS.map((def) => ({
    id: generateId("item"),
    language: "ja",
    type: "vocabulary",
    promptZh: def.promptZh,
    answer: def.answer,
    reading: def.reading,
    explanation: def.explanation,
    source: "manual",
    tags: def.tags,
    status: "new",
    createdAt,
    isSeed: true,
  }));
}
