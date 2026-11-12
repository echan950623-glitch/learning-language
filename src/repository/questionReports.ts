import { accountStorage } from "./accountStorage";

/**
 * A learner's flag on one built-in question. Built-in questions live in the app, so a flag only has to
 * (a) keep that question out of later rounds on this device and (b) leave text to paste to whoever
 * corrects it. It is stored with the account's local values and is not synced between devices.
 * A corrected question gets a new variant id, which ends the flag by itself.
 */
export interface QuestionReport {
  conceptKey: string;
  variantId: string;
  /** The question as shown, with its choices or blank. */
  prompt: string;
  answer: string;
  note?: string;
  at: string;
}

const STORAGE_KEY = "learning-language:question-reports:v1";
const MAX_REPORTS = 200;

export const reportKey = (report: Pick<QuestionReport, "conceptKey" | "variantId">) => `${report.conceptKey}#${report.variantId}`;

const isReport = (value: unknown): value is QuestionReport => {
  const report = value as Partial<QuestionReport> | null;
  return !!report && typeof report === "object" && [report.conceptKey, report.variantId, report.prompt, report.answer, report.at].every(field => typeof field === "string" && field.length > 0);
};

export function listQuestionReports(storage?: Storage): QuestionReport[] {
  try {
    const saved: unknown = JSON.parse((storage ?? accountStorage()).getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter(isReport) : [];
  } catch {
    return [];
  }
}

/** Keys of flagged questions, for keeping them out of rotation. Empty when storage is unavailable. */
export function reportedQuestionKeys(storage?: Storage): ReadonlySet<string> {
  return new Set(listQuestionReports(storage).map(reportKey));
}

/** Writes need the same atomic transaction as every other account value. */
export function addQuestionReport(report: QuestionReport, storage?: Storage): void {
  const target = storage ?? accountStorage();
  const kept = listQuestionReports(target).filter(existing => reportKey(existing) !== reportKey(report));
  target.setItem(STORAGE_KEY, JSON.stringify([...kept, { ...report, ...(report.note?.trim() ? { note: report.note.trim().slice(0, 300) } : { note: undefined }) }].slice(-MAX_REPORTS)));
}

export function clearQuestionReports(storage?: Storage): void {
  (storage ?? accountStorage()).removeItem(STORAGE_KEY);
}

/** Plain text meant to be pasted into a conversation about fixing the questions. */
export function formatQuestionReports(reports: readonly QuestionReport[]): string {
  if (!reports.length) return "";
  return [`題目回報（${reports.length} 題）`, ...reports.map((report, index) => [
    `${index + 1}. ${report.conceptKey} / ${report.variantId}`,
    `題目：${report.prompt.replace(/\n/g, " ／ ")}`,
    `答案：${report.answer}`,
    ...(report.note ? [`說明：${report.note}`] : []),
  ].join("\n"))].join("\n\n");
}
