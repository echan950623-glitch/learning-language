import { describe, expect, it } from "vitest";
import { abilityDisplayLabel } from "./labels";

describe("abilityDisplayLabel", () => {
  it("reading 標示讀音回想", () => {
    expect(abilityDisplayLabel("reading", { answer: "先生" })).toBe("讀音回想");
    expect(abilityDisplayLabel("reading", { answer: "ありがとう" })).toBe("讀音回想");
  });

  it("含漢字的詞彙回想不宣稱手寫能力", () => {
    expect(abilityDisplayLabel("recall", { answer: "先生" })).toBe("詞彙回想");
    expect(abilityDisplayLabel("recall", { answer: "学生" })).toBe("詞彙回想");
  });

  it("純假名也標示詞彙回想", () => {
    expect(abilityDisplayLabel("recall", { answer: "ありがとう" })).toBe("詞彙回想");
    expect(abilityDisplayLabel("recall", { answer: "コーヒー" })).toBe("詞彙回想");
  });

  it("不會出現 recall／reading 英文內部名稱", () => {
    const labels = [
      abilityDisplayLabel("recall", { answer: "先生" }),
      abilityDisplayLabel("recall", { answer: "ありがとう" }),
      abilityDisplayLabel("reading", { answer: "先生" }),
    ];
    for (const label of labels) {
      expect(label).not.toMatch(/recall|reading/i);
    }
  });
});
