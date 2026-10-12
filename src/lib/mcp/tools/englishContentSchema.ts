import { z } from "zod";

// Optional fields allow per-item errors in batch validation, rather than losing the whole batch.
export const englishContentSchema = z.object({
  activeVariantId: z.string().optional().describe("僅供已出題快照讀回；新增時必須省略"),
  version: z.number().optional().describe("英文內容版本，必須為 1"),
  senseKey: z.string().optional().describe("指定詞義的穩定識別，不含使用者身分"),
  variants: z.array(z.object({
    id: z.string().optional(), mode: z.string().optional().describe("direct（直接辨義）或 context（句中辨義）"),
    sentence: z.string().optional(), targetText: z.string().optional().describe("句中實際表達，可含片語替換或詞形變化"),
    translationZh: z.string().optional(), choices: z.array(z.object({id:z.string().optional(),text:z.string().optional()})).optional().describe("四個不同選項，含唯一正確答案"),
    correctChoiceId: z.string().optional(), explanationZh: z.string().optional(), hint: z.string().optional(),
    role: z.string().optional().describe("practice 或 verification；至少預留一題情境驗證"),
  })).optional().describe("建議 1 個直接辨義＋4 個情境；周邊用字簡單，指定詞義相同，情境不同"),
});
