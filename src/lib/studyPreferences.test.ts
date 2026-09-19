import { describe, expect, it } from "vitest";

import { MemoryStorage } from "@/test/localStorageMock";
import {
  applySyncedPreferences,
  DEFAULT_STUDY_QUESTION_COUNT,
  readDailyNewItemCap,
  readStudyQuestionCount,
  saveStudyQuestionCount,
} from "./studyPreferences";

describe("每次學習題數設定", () => {
  it("沒有設定或內容損壞時使用預設 10 題", () => {
    const storage = new MemoryStorage();
    expect(readStudyQuestionCount(storage)).toBe(DEFAULT_STUDY_QUESTION_COUNT);
    storage.setItem("learning-language:study-preferences:v1", "999");
    expect(readStudyQuestionCount(storage)).toBe(10);
  });

  it("可保存並重新讀取 5／10／15／20 題", () => {
    const storage = new MemoryStorage();
    for (const count of [5, 10, 15, 20] as const) {
      saveStudyQuestionCount(count, storage);
      expect(readStudyQuestionCount(storage)).toBe(count);
    }
  });

  it("拒絕保存選項外的題數", () => {
    const storage = new MemoryStorage();
    expect(() => saveStudyQuestionCount(7 as never, storage)).toThrow(/不支援/);
    expect(readStudyQuestionCount(storage)).toBe(10);
  });

  it("讀取儲存空間失敗時安全回到 10 題", () => {
    const brokenStorage = new MemoryStorage();
    brokenStorage.getItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    expect(readStudyQuestionCount(brokenStorage)).toBe(10);
  });

  it("套用雲端偏好時不經通知流程，兩個值一起寫回本機", () => {
    const storage = new MemoryStorage();
    applySyncedPreferences({ dailyQuestionCount: 15, dailyNewItemCap: 20 }, storage);
    expect(readStudyQuestionCount(storage)).toBe(15);
    expect(readDailyNewItemCap(storage)).toBe(20);
  });
});
