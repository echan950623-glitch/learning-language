/**
 * 文字比對用的最小共用工具，跟「這個項目需要哪些能力」（abilities.ts）、
 * 「怎麼判斷這次作答對不對」（grading.ts）分開，純粹處理字串本身。
 */

/** CJK 統一表意文字（含常用漢字）範圍；用來判斷一個答案是不是「漢字」而不是純假名／外文。 */
const KANJI_RANGE = /[一-鿿㐀-䶿]/;

export function containsKanji(value: string): boolean {
  return KANJI_RANGE.test(value);
}

/** 片假名（ァ～ヶ，U+30A1–U+30F6）逐字轉對應平假名（減 0x60 即為平假名區段）。非片假名字元原樣保留。 */
export function katakanaToHiragana(value: string): string {
  return value.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/**
 * 作答比對用的正規化：Unicode NFKC（全形／半形、相容字形統一）＋移除所有空白字元。
 * 這個 App 的答案都是單一日文詞彙，詞彙內本來就不該有空白，所以「合理處理多餘空格」
 * 在這裡直接定義成「整段清除」，同時涵蓋 trim（頭尾空白）與詞中間誤觸的空白。
 */
export function normalizeForComparison(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "");
}
