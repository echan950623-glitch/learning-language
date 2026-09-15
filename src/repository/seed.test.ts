import { describe, expect, it } from "vitest";

import { buildCommonVocabularyInputs, buildSeedItems } from "./seed";

describe("常用日文單字包", () => {
  it("提供 30 個不重複且可練漢字與平假名的初級單字", () => {
    const inputs = buildCommonVocabularyInputs();
    const keys = inputs.map((item) => `${item.promptZh}|${item.answer}|${item.reading}`);

    expect(inputs).toHaveLength(30);
    expect(new Set(keys).size).toBe(30);
    expect(inputs.every((item) => item.language === "ja" && item.type === "vocabulary")).toBe(true);
    expect(inputs.every((item) => item.isSeed && item.reading && item.reading !== item.answer)).toBe(true);
  });

  it("全新安裝會同時包含原本 6 個範例與 30 個常用單字", () => {
    const items = buildSeedItems(new Date("2026-09-15T00:00:00.000Z"));
    expect(items).toHaveLength(36);
    expect(items.some((item) => item.answer === "学生" && item.reading === "がくせい")).toBe(true);
    expect(items.some((item) => item.answer === "電車" && item.reading === "でんしゃ")).toBe(true);
  });
});
