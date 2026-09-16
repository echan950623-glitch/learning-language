/**
 * 平假名／片假名 → 羅馬拼音，純函式、確定性轉換（不使用 AI，也沒有隨機性）。
 *
 * 用途：MCP `preview_vocabulary_batch` 需要驗證 AI 提供的羅馬拼音是否與讀音一致
 * （PRODUCT 要求「羅馬拼音需一致產生或驗證；不要依賴每次答題呼叫 AI」）。與其信任
 * AI 每次給的羅馬拼音，這裡永遠用同一套規則從 `reading`（假名）重新推導，
 * 保證同樣輸入永遠得到同樣輸出，AI 給的值只拿來跟這裡的結果比對、提示不一致，
 * 不直接採信。
 *
 * 範圍（刻意簡化，不是隱藏限制）：
 * - 逐音節（モーラ）轉寫，不做長音符號（ō／ū 這種 macron）——おう 轉成 "ou"、
 *   えい 轉成 "ei"，不是 Hepburn 傳統的 "ō"／"ei"；こんにちは 這種字面上ば行以外的
 *   歷史假名遣い（は讀作 wa）也不做語境修正，一律照字面音節轉寫。這樣每個假名
 *   字元的對應關係固定、容易驗證。
 * - 促音（っ）讓下一個子音重複一次；片假名長音記號「ー」重複前一個母音。
 * - 拗音（ゃゅょ）與外來語常見的小字母音組合（ぁぃぅぇぉ，例如 ティ／ファ／
 *   ウィ／ヴァ）都視為與前一個假名合併成一個音節；沒有對應組合規則的小字母音
 *   會安全退化成獨立母音（不會原樣洩漏未轉換的假名字元）。
 * - ん 一律轉成 "n"；後面接母音或 y 開頭時插入撇號（'）消歧義（例：きんようび
 *   → "kin'youbi"），這是修正版 Hepburn 常見規則。
 * - 只處理平假名／片假名；其他字元（漢字、標點、空白、既有羅馬字）原樣保留，
 *   不會拋出例外。
 */

const SMALL_TSU = "っ";
const KATAKANA_LONG_MARK = "ー";
const N_KANA = "ん";

type SmallKana = "ゃ" | "ゅ" | "ょ" | "ぁ" | "ぃ" | "ぅ" | "ぇ" | "ぉ";
const SMALL_KANA_SET = new Set<string>(["ゃ", "ゅ", "ょ", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ"]);

/** 平假名基礎音節表，含小字母音自己單獨出現時的安全退化（ぁ→a 等）。 */
const BASE_MORA: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "wi", ゑ: "we", を: "wo",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ゔ: "vu",
};

/**
 * 「子音假名＋小字母音」組合成單一音節，key 是前一個假名。涵蓋標準拗音
 * （きゃ／しゃ…）與外來語常見的小字母音組合（ティ／ファ／ウィ／ヴァ…）。
 * 沒有列在這裡的組合會退化成前一個假名＋小字母音各自轉寫（見 toRomaji）。
 */
const COMBO_BASE: Partial<Record<string, Partial<Record<SmallKana, string>>>> = {
  き: { ゃ: "kya", ゅ: "kyu", ょ: "kyo" },
  し: { ゃ: "sha", ゅ: "shu", ょ: "sho", ぇ: "she" },
  ち: { ゃ: "cha", ゅ: "chu", ょ: "cho", ぇ: "che" },
  に: { ゃ: "nya", ゅ: "nyu", ょ: "nyo" },
  ひ: { ゃ: "hya", ゅ: "hyu", ょ: "hyo" },
  み: { ゃ: "mya", ゅ: "myu", ょ: "myo" },
  り: { ゃ: "rya", ゅ: "ryu", ょ: "ryo" },
  ぎ: { ゃ: "gya", ゅ: "gyu", ょ: "gyo" },
  じ: { ゃ: "ja", ゅ: "ju", ょ: "jo", ぇ: "je" },
  ぢ: { ゃ: "ja", ゅ: "ju", ょ: "jo" },
  び: { ゃ: "bya", ゅ: "byu", ょ: "byo" },
  ぴ: { ゃ: "pya", ゅ: "pyu", ょ: "pyo" },
  て: { ぃ: "ti", ゅ: "tyu" },
  で: { ぃ: "di", ゅ: "dyu" },
  と: { ぅ: "tu" },
  ど: { ぅ: "du" },
  ふ: { ぁ: "fa", ぃ: "fi", ぇ: "fe", ぉ: "fo", ゅ: "fyu" },
  う: { ぃ: "wi", ぇ: "we", ぉ: "wo" },
  ゔ: { ぁ: "va", ぃ: "vi", ぇ: "ve", ぉ: "vo" },
};

const HIRAGANA_START = 0x3041;
const HIRAGANA_END = 0x3096;
const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30fa;

/** 片假名逐字轉平假名（沿用跟 text.ts 的 katakanaToHiragana 相同的位移規則）。 */
function katakanaCharToHiragana(char: string): string {
  const code = char.codePointAt(0);
  if (code === undefined) return char;
  if (code >= KATAKANA_START && code <= KATAKANA_END) {
    return String.fromCodePoint(code - (KATAKANA_START - HIRAGANA_START));
  }
  return char;
}

function isHiraganaChar(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  return code >= HIRAGANA_START && code <= HIRAGANA_END;
}

function firstRomajiConsonant(romaji: string): string {
  // "chi"/"cha" 系列固定用 t 重複促音（慣例 "matcha" 而非 "macccha"）。
  if (romaji.startsWith("ch")) return "t";
  return romaji.charAt(0);
}

/**
 * 把任意字串（通常是 LearningItem.reading）轉成羅馬拼音。
 * 非假名字元（漢字、標點、既有羅馬字、空白）原樣保留、不拋出例外。
 */
export function toRomaji(input: string): string {
  const chars = Array.from(input);
  let result = "";
  let i = 0;

  while (i < chars.length) {
    const rawChar = chars[i];

    if (rawChar === KATAKANA_LONG_MARK) {
      const lastVowel = result.match(/[aiueo](?=[^aiueo]*$)/)?.[0];
      result += lastVowel ?? "";
      i += 1;
      continue;
    }

    const char = katakanaCharToHiragana(rawChar);

    if (char === SMALL_TSU) {
      const nextChar = chars[i + 1] ? katakanaCharToHiragana(chars[i + 1]) : undefined;
      const nextRomaji = nextChar ? BASE_MORA[nextChar] : undefined;
      if (nextRomaji) {
        result += firstRomajiConsonant(nextRomaji);
      }
      i += 1;
      continue;
    }

    if (char === N_KANA) {
      const nextChar = chars[i + 1] ? katakanaCharToHiragana(chars[i + 1]) : undefined;
      const nextIsVowelOrY =
        nextChar !== undefined &&
        isHiraganaChar(nextChar) &&
        /^(a|i|u|e|o|ya|yu|yo)/.test(BASE_MORA[nextChar] ?? "");
      result += nextIsVowelOrY ? "n'" : "n";
      i += 1;
      continue;
    }

    const combo = COMBO_BASE[char];
    const nextSmall = chars[i + 1] ? katakanaCharToHiragana(chars[i + 1]) : undefined;
    if (combo && nextSmall && SMALL_KANA_SET.has(nextSmall)) {
      const combined = combo[nextSmall as SmallKana];
      if (combined) {
        result += combined;
        i += 2;
        continue;
      }
    }

    const mora = BASE_MORA[char];
    if (mora) {
      result += mora;
      i += 1;
      continue;
    }

    // 不認得的字元（漢字、標點、既有羅馬字等）原樣保留。
    result += rawChar;
    i += 1;
  }

  return result;
}

/** 比較 AI 提供的羅馬拼音是否與從 reading 推導出的結果一致（忽略大小寫）。 */
export function romajiMatchesReading(reading: string, candidateRomaji: string): boolean {
  return toRomaji(reading).toLowerCase() === candidateRomaji.trim().toLowerCase();
}
