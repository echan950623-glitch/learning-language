import { describe, expect, it } from "vitest";
import { StudyActionGuard } from "./actionGuard";

describe("study card transitions", () => {
  it("rejects repeated clicks during a slow save and queued clicks after it finishes", () => {
    const guard = new StudyActionGuard();
    expect(guard.begin("word-a", 100, 100)).toBe(true);
    expect(guard.begin("word-a", 2000, 2000)).toBe(false);
    guard.finish("word-a", true, 3000);
    expect(guard.begin("word-b", 2000, 3500)).toBe(false);
    expect(guard.begin("word-b", 3200, 3500)).toBe(false);
    expect(guard.begin("word-a", 3600, 3600)).toBe(false);
    expect(guard.begin("word-b", 3600, 3600)).toBe(true);
  });

  it("allows a failed save to be retried on the same word", () => {
    const guard = new StudyActionGuard();
    expect(guard.begin("word-a", 100, 100)).toBe(true);
    guard.finish("word-a", false, 5000);
    expect(guard.begin("word-a", 5100, 5100)).toBe(true);
  });

  it("compares queued WebKit epoch timestamps in the same clock as the transition", () => {
    const guard = new StudyActionGuard();
    expect(guard.begin("word-a", performance.timeOrigin + 100, 100)).toBe(true);
    guard.finish("word-a", true, 1000);
    expect(guard.begin("word-b", performance.timeOrigin + 900, 2000)).toBe(false);
    expect(guard.begin("word-b", performance.timeOrigin + 1500, 2000)).toBe(true);
  });
});
