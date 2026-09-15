/**
 * 範例種子資料：只在「本機從未有任何存檔」的真正第一次啟動時注入，
 * 方便第一次打開 App 與測試時有東西可看。全部標記 isSeed: true，
 * 使用者可在進度頁一次清除，不會被誤認成 AI 自動產生或使用者真實學習資料。
 */

import type { LearningItem, NewLearningItemInput } from "../domain/types";
import { generateId } from "../domain/id";

interface SeedDefinition {
  promptZh: string;
  answer: string;
  reading: string;
  explanation?: string;
  tags: string[];
}

const STARTER_DEFINITIONS: SeedDefinition[] = [
  { promptZh: "你好", answer: "こんにちは", reading: "こんにちは", explanation: "日常問候語，用於白天見面時", tags: ["範例", "問候"] },
  { promptZh: "謝謝", answer: "ありがとう", reading: "ありがとう", tags: ["範例", "問候"] },
  { promptZh: "學生", answer: "学生", reading: "がくせい", explanation: "漢字讀音練習範例", tags: ["範例", "名詞"] },
  { promptZh: "吃", answer: "食べる", reading: "たべる", tags: ["範例", "動詞"] },
  { promptZh: "朋友", answer: "友達", reading: "ともだち", tags: ["範例", "名詞"] },
  { promptZh: "水", answer: "水", reading: "みず", tags: ["範例", "名詞"] },
];

const COMMON_VOCABULARY_DEFINITIONS: SeedDefinition[] = [
  { promptZh: "人", answer: "人", reading: "ひと", tags: ["常用單字包", "名詞"] },
  { promptZh: "日本", answer: "日本", reading: "にほん", tags: ["常用單字包", "地點"] },
  { promptZh: "今天", answer: "今日", reading: "きょう", tags: ["常用單字包", "時間"] },
  { promptZh: "明天", answer: "明日", reading: "あした", tags: ["常用單字包", "時間"] },
  { promptZh: "昨天", answer: "昨日", reading: "きのう", tags: ["常用單字包", "時間"] },
  { promptZh: "早上", answer: "朝", reading: "あさ", tags: ["常用單字包", "時間"] },
  { promptZh: "中午", answer: "昼", reading: "ひる", tags: ["常用單字包", "時間"] },
  { promptZh: "晚上", answer: "夜", reading: "よる", tags: ["常用單字包", "時間"] },
  { promptZh: "家", answer: "家", reading: "いえ", tags: ["常用單字包", "地點"] },
  { promptZh: "學校", answer: "学校", reading: "がっこう", tags: ["常用單字包", "地點"] },
  { promptZh: "公司", answer: "会社", reading: "かいしゃ", tags: ["常用單字包", "地點"] },
  { promptZh: "車站", answer: "駅", reading: "えき", tags: ["常用單字包", "交通"] },
  { promptZh: "電車", answer: "電車", reading: "でんしゃ", tags: ["常用單字包", "交通"] },
  { promptZh: "書", answer: "本", reading: "ほん", tags: ["常用單字包", "名詞"] },
  { promptZh: "名字", answer: "名前", reading: "なまえ", tags: ["常用單字包", "名詞"] },
  { promptZh: "老師", answer: "先生", reading: "せんせい", tags: ["常用單字包", "人物"] },
  { promptZh: "貓", answer: "猫", reading: "ねこ", tags: ["常用單字包", "動物"] },
  { promptZh: "狗", answer: "犬", reading: "いぬ", tags: ["常用單字包", "動物"] },
  { promptZh: "去", answer: "行く", reading: "いく", tags: ["常用單字包", "動詞"] },
  { promptZh: "來", answer: "来る", reading: "くる", tags: ["常用單字包", "動詞"] },
  { promptZh: "看", answer: "見る", reading: "みる", tags: ["常用單字包", "動詞"] },
  { promptZh: "聽", answer: "聞く", reading: "きく", explanation: "也可表示詢問", tags: ["常用單字包", "動詞"] },
  { promptZh: "說話", answer: "話す", reading: "はなす", tags: ["常用單字包", "動詞"] },
  { promptZh: "喝", answer: "飲む", reading: "のむ", tags: ["常用單字包", "動詞"] },
  { promptZh: "買", answer: "買う", reading: "かう", tags: ["常用單字包", "動詞"] },
  { promptZh: "讀", answer: "読む", reading: "よむ", tags: ["常用單字包", "動詞"] },
  { promptZh: "寫", answer: "書く", reading: "かく", tags: ["常用單字包", "動詞"] },
  { promptZh: "大的", answer: "大きい", reading: "おおきい", tags: ["常用單字包", "形容詞"] },
  { promptZh: "小的", answer: "小さい", reading: "ちいさい", tags: ["常用單字包", "形容詞"] },
  { promptZh: "開心／有趣", answer: "楽しい", reading: "たのしい", tags: ["常用單字包", "形容詞"] },
];

function toSeedInput(def: SeedDefinition): NewLearningItemInput {
  return {
    language: "ja",
    type: "vocabulary",
    promptZh: def.promptZh,
    answer: def.answer,
    reading: def.reading,
    explanation: def.explanation,
    source: "manual",
    tags: [...def.tags],
    isSeed: true,
  };
}

export function buildCommonVocabularyInputs(): NewLearningItemInput[] {
  return COMMON_VOCABULARY_DEFINITIONS.map(toSeedInput);
}

export function buildSeedItems(now: Date): LearningItem[] {
  const createdAt = now.toISOString();
  return [...STARTER_DEFINITIONS, ...COMMON_VOCABULARY_DEFINITIONS].map((def) => ({
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
