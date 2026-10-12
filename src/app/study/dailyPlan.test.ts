import { beforeEach, expect, it } from "vitest";
import { installMockLocalStorage } from "../../test/localStorageMock";
import {
  __resetRepositorySingletonForTests,
  mutateRepository,
} from "../../repository";
import { LocalStorageLearningRepository } from "../../repository/localStorageRepository";
import { prepareDailyPlan } from "./dailyPlan";

beforeEach(() => {
  installMockLocalStorage();
  __resetRepositorySingletonForTests();
});
it("persists explicitly added guest content and the daily plan across repository reload", async () => {
  const now = new Date("2026-10-03T06:00:00Z");
  await mutateRepository((repository) => {
    for (let index = 0; index < 6; index++)
      repository.addItem({
        language: "ja",
        type: "vocabulary",
        promptZh: `測試 ${index}`,
        answer: `単語${index}`,
        source: "ai",
        tags: [],
      });
  });
  const first = await prepareDailyPlan(now);
  const restored = new LocalStorageLearningRepository();
  expect(first.newItemIds).toHaveLength(5);
  expect(
    first.units.every((unit) => restored.getItem(unit.learningItemId)),
  ).toBe(true);
  __resetRepositorySingletonForTests();
  expect((await prepareDailyPlan(now)).newItemIds).toEqual(first.newItemIds);
});
