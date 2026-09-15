import { describe, expect, it } from "vitest";
import { gradeAttempt } from "./grading";

describe("gradeAttempt — 漢字／單字練習（recall）", () => {
  it("完全相符判定正確", () => {
    const result = gradeAttempt({ ability: "recall", rawInput: "先生", expectedAnswer: "先生" });
    expect(result.correct).toBe(true);
    expect(result.normalizedInput).toBe("先生");
    expect(result.expectedAnswer).toBe("先生");
  });

  it("不相符判定錯誤", () => {
    const result = gradeAttempt({ ability: "recall", rawInput: "学生", expectedAnswer: "先生" });
    expect(result.correct).toBe(false);
    expect(result.normalizedInput).toBe("学生");
    expect(result.expectedAnswer).toBe("先生");
  });

  it("部分相符（子字串）不算正確，必須完整比對", () => {
    expect(gradeAttempt({ ability: "recall", rawInput: "先", expectedAnswer: "先生" }).correct).toBe(false);
    expect(gradeAttempt({ ability: "recall", rawInput: "先生です", expectedAnswer: "先生" }).correct).toBe(false);
  });

  it("純假名詞彙也能作為單字練習使用", () => {
    expect(gradeAttempt({ ability: "recall", rawInput: "ありがとう", expectedAnswer: "ありがとう" }).correct).toBe(
      true
    );
  });

  it("頭尾空白與詞中間空白不影響判定", () => {
    expect(gradeAttempt({ ability: "recall", rawInput: "  先生  ", expectedAnswer: "先生" }).correct).toBe(true);
    expect(gradeAttempt({ ability: "recall", rawInput: "先 生", expectedAnswer: "先生" }).correct).toBe(true);
  });

  it("NFKC：全形字元輸入視為與半形相同", () => {
    expect(gradeAttempt({ ability: "recall", rawInput: "ＡＢＣ", expectedAnswer: "ABC" }).correct).toBe(true);
  });

  it("空白輸入一律不可判定為正確", () => {
    const result = gradeAttempt({ ability: "recall", rawInput: "   ", expectedAnswer: "先生" });
    expect(result.correct).toBe(false);
    expect(result.normalizedInput).toBe("");
  });

  it("空字串輸入不可判定為正確", () => {
    expect(gradeAttempt({ ability: "recall", rawInput: "", expectedAnswer: "先生" }).correct).toBe(false);
  });
});

describe("gradeAttempt — 平假名讀音練習（reading）", () => {
  it("平假名輸入與期望讀音完全相符判定正確", () => {
    const result = gradeAttempt({ ability: "reading", rawInput: "せんせい", expectedAnswer: "せんせい" });
    expect(result.correct).toBe(true);
  });

  it("讀音不符判定錯誤", () => {
    const result = gradeAttempt({ ability: "reading", rawInput: "がくせい", expectedAnswer: "せんせい" });
    expect(result.correct).toBe(false);
    expect(result.expectedAnswer).toBe("せんせい");
  });

  it("片假名輸入轉平假名後可判定正確", () => {
    expect(gradeAttempt({ ability: "reading", rawInput: "センセイ", expectedAnswer: "せんせい" }).correct).toBe(
      true
    );
  });

  it("片假名與平假名混用輸入轉換後仍可判定正確", () => {
    expect(gradeAttempt({ ability: "reading", rawInput: "センせい", expectedAnswer: "せんせい" }).correct).toBe(
      true
    );
  });

  it("羅馬字輸入（如 sensei）不接受", () => {
    expect(gradeAttempt({ ability: "reading", rawInput: "sensei", expectedAnswer: "せんせい" }).correct).toBe(
      false
    );
  });

  it("羅馬字大寫輸入也不接受", () => {
    expect(gradeAttempt({ ability: "reading", rawInput: "SENSEI", expectedAnswer: "せんせい" }).correct).toBe(
      false
    );
  });

  it("讀音比對也要求完整比對，部分相符不算正確", () => {
    expect(gradeAttempt({ ability: "reading", rawInput: "せん", expectedAnswer: "せんせい" }).correct).toBe(false);
  });

  it("頭尾與中間空白不影響讀音判定", () => {
    expect(gradeAttempt({ ability: "reading", rawInput: " せん せい ", expectedAnswer: "せんせい" }).correct).toBe(
      true
    );
  });

  it("空白輸入一律不可判定為正確", () => {
    expect(gradeAttempt({ ability: "reading", rawInput: "　　", expectedAnswer: "せんせい" }).correct).toBe(false);
  });

  it("normalizedInput 反映片假名轉換後的結果，方便 UI 顯示", () => {
    const result = gradeAttempt({ ability: "reading", rawInput: "センセイ", expectedAnswer: "せんせい" });
    expect(result.normalizedInput).toBe("せんせい");
  });
});
