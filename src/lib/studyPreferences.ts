export const STUDY_QUESTION_COUNT_OPTIONS = [5, 10, 15, 20] as const;
export type StudyQuestionCount = (typeof STUDY_QUESTION_COUNT_OPTIONS)[number];
export const DEFAULT_STUDY_QUESTION_COUNT: StudyQuestionCount = 10;

const STORAGE_KEY = "learning-language:study-preferences:v1";

function isStudyQuestionCount(value: number): value is StudyQuestionCount {
  return STUDY_QUESTION_COUNT_OPTIONS.includes(value as StudyQuestionCount);
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readStudyQuestionCount(storage: Storage | undefined = browserStorage()): StudyQuestionCount {
  if (!storage) return DEFAULT_STUDY_QUESTION_COUNT;
  try {
    const value = Number(storage.getItem(STORAGE_KEY));
    return isStudyQuestionCount(value) ? value : DEFAULT_STUDY_QUESTION_COUNT;
  } catch {
    return DEFAULT_STUDY_QUESTION_COUNT;
  }
}

export function saveStudyQuestionCount(
  count: StudyQuestionCount,
  storage: Storage | undefined = browserStorage()
): void {
  if (!isStudyQuestionCount(count)) throw new Error(`不支援的每次學習題數：${count}`);
  if (!storage) throw new Error("這個瀏覽器目前無法保存設定");
  storage.setItem(STORAGE_KEY, String(count));
}
