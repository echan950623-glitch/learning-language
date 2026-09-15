import { describe, expect, it } from "vitest";
import {
  MASTERY_STREAK,
  REVIEW_INTERVALS_DAYS,
  STRUGGLE_LAPSE_THRESHOLD,
  combineAbilityStatuses,
  computeNextSchedule,
  deriveStatus,
  intervalForStreak,
} from "./srs";

const NOW = new Date("2026-09-14T09:00:00.000Z");

function daysAfterNow(days: number): string {
  const d = new Date(NOW.getTime());
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

describe("intervalForStreak", () => {
  it("回傳對應 REVIEW_INTERVALS_DAYS 的間隔", () => {
    expect(intervalForStreak(1)).toBe(1);
    expect(intervalForStreak(2)).toBe(3);
    expect(intervalForStreak(3)).toBe(7);
    expect(intervalForStreak(4)).toBe(14);
    expect(intervalForStreak(5)).toBe(30);
  });

  it("streak 超過陣列長度時停留在最後一個間隔", () => {
    expect(intervalForStreak(6)).toBe(30);
    expect(intervalForStreak(100)).toBe(30);
  });

  it("streak 為 0 或負數時回退到第一個間隔", () => {
    expect(intervalForStreak(0)).toBe(1);
    expect(intervalForStreak(-1)).toBe(1);
  });
});

describe("computeNextSchedule — 新項目第一次作答", () => {
  it("第一次答對：streak=1、間隔 1 天、狀態 learning", () => {
    const next = computeNextSchedule(null, "correct", NOW);
    expect(next.streak).toBe(1);
    expect(next.lapseCount).toBe(0);
    expect(next.intervalDays).toBe(1);
    expect(next.dueAt).toBe(daysAfterNow(1));
    expect(next.status).toBe("learning");
  });

  it("第一次部分答對：streak 維持 0、間隔 1 天、狀態轉為 learning", () => {
    const next = computeNextSchedule(null, "partial", NOW);
    expect(next.streak).toBe(0);
    expect(next.lapseCount).toBe(0);
    expect(next.intervalDays).toBe(1);
    expect(next.status).toBe("learning");
  });

  it("第一次答錯：streak=0、lapseCount=1、間隔 1 天", () => {
    const next = computeNextSchedule(null, "incorrect", NOW);
    expect(next.streak).toBe(0);
    expect(next.lapseCount).toBe(1);
    expect(next.intervalDays).toBe(1);
    expect(next.status).toBe("learning");
  });
});

describe("computeNextSchedule — 連續答對延長間隔並最終 mastered", () => {
  it("依序走過 1、3、7、14、30 天，第 5 次答對達 mastered 門檻", () => {
    let position: { streak: number; lapseCount: number } | null = null;
    const expectedIntervals = [...REVIEW_INTERVALS_DAYS];

    expectedIntervals.forEach((expectedInterval, i) => {
      const next = computeNextSchedule(position, "correct", NOW);
      expect(next.intervalDays).toBe(expectedInterval);
      expect(next.streak).toBe(i + 1);
      position = { streak: next.streak, lapseCount: next.lapseCount };

      if (i + 1 < MASTERY_STREAK) {
        expect(next.status).toBe("learning");
      } else {
        expect(next.status).toBe("mastered");
      }
    });
  });
});

describe("computeNextSchedule — 部分答對不增加也不歸零進度", () => {
  it("已有 streak 時部分答對，streak 維持不變、間隔回到 1 天", () => {
    const previous = { streak: 2, lapseCount: 0 };
    const next = computeNextSchedule(previous, "partial", NOW);
    expect(next.streak).toBe(2);
    expect(next.lapseCount).toBe(0);
    expect(next.intervalDays).toBe(1);
  });
});

describe("computeNextSchedule — 答錯重設進度", () => {
  it("已有 streak 時答錯，streak 歸零、lapseCount +1、間隔回到 1 天", () => {
    const previous = { streak: 3, lapseCount: 1 };
    const next = computeNextSchedule(previous, "incorrect", NOW);
    expect(next.streak).toBe(0);
    expect(next.lapseCount).toBe(2);
    expect(next.intervalDays).toBe(1);
  });

  it("連續答錯達門檻次數標為 struggling", () => {
    let position: { streak: number; lapseCount: number } | null = null;
    for (let i = 0; i < STRUGGLE_LAPSE_THRESHOLD; i += 1) {
      const next = computeNextSchedule(position, "incorrect", NOW);
      position = { streak: next.streak, lapseCount: next.lapseCount };
      if (i + 1 < STRUGGLE_LAPSE_THRESHOLD) {
        expect(next.status).not.toBe("struggling");
      } else {
        expect(next.status).toBe("struggling");
      }
    }
  });

  it("struggling 之後只要連續答對重新累積到門檻，仍可轉為 mastered", () => {
    let position: { streak: number; lapseCount: number } | null = null;
    for (let i = 0; i < STRUGGLE_LAPSE_THRESHOLD; i += 1) {
      const next = computeNextSchedule(position, "incorrect", NOW);
      position = { streak: next.streak, lapseCount: next.lapseCount };
    }
    expect(deriveStatus(position!.streak, position!.lapseCount, true)).toBe("struggling");

    for (let i = 0; i < MASTERY_STREAK; i += 1) {
      const next = computeNextSchedule(position, "correct", NOW);
      position = { streak: next.streak, lapseCount: next.lapseCount };
      if (i + 1 === MASTERY_STREAK) {
        expect(next.status).toBe("mastered");
      }
    }
    // lapseCount 是累計值，即使後來 mastered，歷史落後次數不會被抹除
    expect(position!.lapseCount).toBe(STRUGGLE_LAPSE_THRESHOLD);
  });
});

describe("deriveStatus", () => {
  it("完全沒作答過回傳 new", () => {
    expect(deriveStatus(0, 0, false)).toBe("new");
  });

  it("作答過但未達任何門檻回傳 learning", () => {
    expect(deriveStatus(1, 0, true)).toBe("learning");
  });

  it("mastered 門檻優先於 struggling 門檻判斷", () => {
    expect(deriveStatus(MASTERY_STREAK, STRUGGLE_LAPSE_THRESHOLD + 5, true)).toBe("mastered");
  });
});

describe("combineAbilityStatuses — R1：多能力合併判斷 item 整體狀態", () => {
  it("全部能力都是 new，整體也是 new", () => {
    expect(combineAbilityStatuses(["new", "new"])).toBe("new");
  });

  it("recall 已經 mastered，但 reading 從未作答（new），整體不能是 mastered", () => {
    expect(combineAbilityStatuses(["mastered", "new"])).toBe("learning");
  });

  it("recall 與 reading 都 mastered，整體才是 mastered", () => {
    expect(combineAbilityStatuses(["mastered", "mastered"])).toBe("mastered");
  });

  it("任何一項 struggling，整體就是 struggling，即使另一項已經 mastered", () => {
    expect(combineAbilityStatuses(["mastered", "struggling"])).toBe("struggling");
    expect(combineAbilityStatuses(["struggling", "learning"])).toBe("struggling");
  });

  it("只有一項必要能力（例如純假名項目只需要 recall）時，直接採用該能力狀態", () => {
    expect(combineAbilityStatuses(["mastered"])).toBe("mastered");
    expect(combineAbilityStatuses(["learning"])).toBe("learning");
  });

  it("空陣列（理論上不會發生）安全回傳 new，不崩潰", () => {
    expect(combineAbilityStatuses([])).toBe("new");
  });
});
