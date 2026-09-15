import { describe, expect, it } from "vitest";
import { containsKanji, katakanaToHiragana, normalizeForComparison } from "./text";

describe("containsKanji", () => {
  it("含漢字的字串回傳 true", () => {
    expect(containsKanji("先生")).toBe(true);
    expect(containsKanji("学生")).toBe(true);
  });

  it("純假名字串回傳 false", () => {
    expect(containsKanji("せんせい")).toBe(false);
    expect(containsKanji("ありがとう")).toBe(false);
    expect(containsKanji("コーヒー")).toBe(false);
  });

  it("混合漢字與假名時回傳 true", () => {
    expect(containsKanji("食べる")).toBe(true);
  });

  it("空字串回傳 false", () => {
    expect(containsKanji("")).toBe(false);
  });
});

describe("katakanaToHiragana", () => {
  it("把片假名逐字轉成平假名", () => {
    expect(katakanaToHiragana("センセイ")).toBe("せんせい");
  });

  it("平假名輸入維持不變", () => {
    expect(katakanaToHiragana("せんせい")).toBe("せんせい");
  });

  it("漢字與非片假名字元原樣保留，只轉片假名部分", () => {
    expect(katakanaToHiragana("お茶ワイン")).toBe("お茶わいん");
  });

  it("不影響羅馬字／半形字元", () => {
    expect(katakanaToHiragana("sensei")).toBe("sensei");
  });
});

describe("normalizeForComparison", () => {
  it("移除頭尾空白", () => {
    expect(normalizeForComparison("  せんせい  ")).toBe("せんせい");
  });

  it("移除詞中間誤觸的空白", () => {
    expect(normalizeForComparison("せん せい")).toBe("せんせい");
    expect(normalizeForComparison("先  生")).toBe("先生");
  });

  it("NFKC 把全形英數字正規化成半形", () => {
    expect(normalizeForComparison("ａｂｃ")).toBe("abc");
    expect(normalizeForComparison("１２３")).toBe("123");
  });

  it("NFKC 把組合形假名（か+濁點）正規化成預組合形（が）", () => {
    const decomposed = "が"; // か + combining dakuten
    expect(normalizeForComparison(decomposed)).toBe("が");
  });

  it("純空白字串正規化為空字串", () => {
    expect(normalizeForComparison("   ")).toBe("");
  });
});
