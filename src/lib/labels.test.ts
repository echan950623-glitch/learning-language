import { describe, expect, it } from "vitest";
import { abilityDisplayLabel } from "./labels";

describe("abilityDisplayLabel", () => {
  it("reading 固定顯示「平假名練習」", () => {
    expect(abilityDisplayLabel("reading", { answer: "先生" })).toBe("平假名練習");
    expect(abilityDisplayLabel("reading", { answer: "ありがとう" })).toBe("平假名練習");
  });

  it("recall 且答案含漢字顯示「漢字練習」", () => {
    expect(abilityDisplayLabel("recall", { answer: "先生" })).toBe("漢字練習");
    expect(abilityDisplayLabel("recall", { answer: "学生" })).toBe("漢字練習");
  });

  it("recall 且答案是純假名顯示「單字練習」", () => {
    expect(abilityDisplayLabel("recall", { answer: "ありがとう" })).toBe("單字練習");
    expect(abilityDisplayLabel("recall", { answer: "コーヒー" })).toBe("單字練習");
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
