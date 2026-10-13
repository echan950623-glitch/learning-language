/** Intervals after introduction, then after each independent due success. */
export const FIXED_REVIEW_POLICY = 1 as const;
export const FIXED_REVIEW_INTERVALS = [1, 3, 5, 7, 14] as const;
export const FINAL_REVIEW_STAGE = FIXED_REVIEW_INTERVALS.length;

export function fixedReviewInterval(stage: number) {
  return FIXED_REVIEW_INTERVALS[Math.min(Math.max(0, stage), FIXED_REVIEW_INTERVALS.length - 1)];
}
