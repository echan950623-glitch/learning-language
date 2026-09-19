import { describe, expect, it } from "vitest";
import { checkItemFieldsCompatible, decideContentKeyConflict, isContentKeyConflict, mergeLearningItemPatch } from "./duplicateItemResolution";
import type { LearningItemRow } from "./outbox";

function row(overrides: Partial<LearningItemRow> = {}): LearningItemRow {
  return { id: "item-a", user_id: "user-a", language: "ja", type: "vocabulary", prompt_zh: "貓", answer: "猫", reading: "ねこ", explanation: null, romaji: null, part_of_speech: null, example_sentence: null, source: "manual", tags: [], status: "new", created_at: "2026-09-19T00:00:00.000Z", is_seed: false, ...overrides };
}

describe("content-key conflict fail-closed decision", () => {
  it("只辨識 content_key 的 23505", () => {
    expect(isContentKeyConflict({ code: "23505", message: "learning_items_user_id_content_key_key" })).toBe(true);
    expect(isContentKeyConflict({ code: "23505", message: "learning_items_pkey" })).toBe(false);
  });
  it("欄位相容且遠端無任何進度才允許 alias", () => {
    const compatibility = checkItemFieldsCompatible(row(), row({ id: "item-b", explanation: "補充" }));
    expect(decideContentKeyConflict({ fieldCompatibility: compatibility, remoteHasProgress: false })).toEqual({ kind: "auto_alias" });
    expect(mergeLearningItemPatch(row(), row({ explanation: "補充", tags: ["n5"] }))).toEqual({ explanation: "補充", tags: ["n5"] });
  });
  it("雙邊非空欄位不同時保留 unresolved conflict", () => {
    const decision = decideContentKeyConflict({ fieldCompatibility: checkItemFieldsCompatible(row({ explanation: "遠端" }), row({ id: "item-b", explanation: "本機" })), remoteHasProgress: false });
    expect(decision.kind).toBe("unresolved_conflict");
    if (decision.kind === "unresolved_conflict") expect(decision.reason).toBe("fields_incompatible");
  });
  it("遠端已有任一進度時不以較新排程自動選邊", () => {
    const decision = decideContentKeyConflict({ fieldCompatibility: { compatible: true }, remoteHasProgress: true });
    expect(decision.kind).toBe("unresolved_conflict");
    if (decision.kind === "unresolved_conflict") expect(decision.reason).toBe("remote_has_progress");
  });
});
