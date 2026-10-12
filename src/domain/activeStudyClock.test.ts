import { expect, it } from "vitest";
import { ActiveStudyClock } from "./activeStudyClock";
it("excludes a long background stay and resumes foreground timing", () => {
  const clock = new ActiveStudyClock();
  clock.reset(1000, true);
  clock.setVisible(4000, false);
  expect(clock.elapsed(100000)).toBe(3000);
  clock.setVisible(100000, true);
  expect(clock.elapsed(105000)).toBe(8000);
  clock.reset(200000, false);
  expect(clock.elapsed(300000)).toBe(0);
});
