/** Deterministic forms. Group is explicit: never infer ichidan from a る ending. */
export type JapaneseWordClass = "godan" | "ichidan" | "suru" | "kuru" | "i_adjective" | "na_adjective" | "noun";
export interface JapaneseWord { dictionary: string; reading: string; wordClass: JapaneseWordClass; meaning: string }
export interface FormDefinition { id: string; label: string; category: string; classes: JapaneseWordClass[]; explanation: string }
const verbs: JapaneseWordClass[] = ["godan", "ichidan", "suru", "kuru"];
const all: JapaneseWordClass[] = [...verbs, "i_adjective", "na_adjective", "noun"];
const definition = (id: string, label: string, category: string, classes = verbs, explanation = "先確認詞類與原形，再依指定形式變化。") => ({ id, label, category, classes, explanation });
const basic = [
  definition("dictionary", "辭書形", "基礎"), definition("stem", "ます形詞幹", "基礎"),
  definition("te", "て形", "基礎", all, "五段：う・つ・る→って，む・ぶ・ぬ→んで，く→いて（行く→行って），ぐ→いで，す→して。一段去る接て；する→して，来る→来て。"),
  definition("ta", "た形", "基礎", verbs, "從て形把て改た、で改だ；行く→行った。"),
  definition("nai", "ない形", "基礎", verbs, "五段改あ段接ない（う→わない），一段去る接ない；する→しない，来る→来ない。"),
];
const styles = ["plain", "polite"] as const;
const tenses = ["present", "past"] as const;
const polarity = ["positive", "negative"] as const;
const inflections = styles.flatMap(style => tenses.flatMap(tense => polarity.map(sign => definition(
  `${style}_${tense}_${sign}`, `${style === "plain" ? "普通體" : "禮貌體"}・${tense === "past" ? "過去" : "非過去"}・${sign === "negative" ? "否定" : "肯定"}`, "時態與語體", all,
  "非過去可表示現在狀態、習慣或未來，不能一律等同正在進行。い形容詞和な形容詞/名詞的否定、過去形式不同。"
))));
const advanced = [
  definition("potential", "可能形", "進階", verbs, "五段改え段接る，一段去る接られる；する→できる，来る→来られる。"),
  definition("volitional", "意向形（普通體）", "進階"), definition("polite_volitional", "意向形（禮貌體）", "進階"),
  definition("imperative", "命令形", "進階"), definition("prohibition", "禁止形", "進階"),
  definition("ba", "ば條件形", "條件", all), definition("negative_ba", "否定ば條件形", "條件", all),
  definition("tara", "たら條件形", "條件", all), definition("negative_tara", "否定たら條件形", "條件", all),
  definition("passive", "受身形", "語態"), definition("causative", "使役形", "語態"), definition("causative_passive", "使役受身形", "語態"),
];
const constructions = [
  ["te_iru", "ている", "持續/進行或結果狀態，依動詞及情境辨別。"],
  ["te_aru", "てある", "表示有意動作留下的結果，並非所有動詞都適用；這裡只練形式，使用限制另做情境題。"],
  ["te_oku", "ておく", "事先準備或維持狀態。"], ["te_shimau", "てしまう", "完成或遺憾的語氣，需看情境。"],
  ["te_miru", "てみる", "嘗試做某件事。"],
] as const;
const compound = constructions.flatMap(([key, text, note]) => styles.flatMap(style => tenses.flatMap(tense => polarity.map(sign => definition(
  `${key}_${style}_${tense}_${sign}`, `${text}・${style === "plain" ? "普通體" : "禮貌體"}・${tense === "past" ? "過去" : "非過去"}・${sign === "negative" ? "否定" : "肯定"}`, "複合表達", verbs, note
)))));
const derived = ["potential", "passive", "causative", "causative_passive"] as const;
const derivedForms = derived.flatMap(key => ["te", "polite_present_positive", "plain_present_negative", "plain_past_positive", "plain_past_negative", "polite_present_negative", "polite_past_positive", "polite_past_negative"].map(suffix =>
  definition(`${key}__${suffix}`, `${advanced.find(f => f.id === key)!.label}＋${suffix === "te" ? "て形" : inflections.find(f => f.id === suffix)!.label}`, "語態的時態與接續")
));
export const JAPANESE_FORMS: FormDefinition[] = [...basic, ...inflections, ...advanced, ...compound, ...derivedForms,
  definition("adverbial", "連用接續（く／に）", "形容詞與名詞", ["i_adjective", "na_adjective", "noun"]),
  definition("attributive", "修飾名詞的形式", "形容詞與名詞", ["i_adjective", "na_adjective", "noun"]),
  definition("honorific", "常用尊敬表達", "敬語", verbs, "只對已明確收錄的常用動詞提供特殊敬語，不機械套用。"),
  definition("humble", "常用謙讓表達", "敬語", verbs, "謙讓表達的對象與情境另練；不把形式答對當使用正確。"),
  definition("te_ru", "ている → てる（普通體）", "口語"),
  definition("chau", "てしまう → ちゃう／じゃう", "口語"),
  definition("nakya", "なければ → なきゃ", "口語"),
];
const endings = "うつるむぶぬくぐす";
const aRow = "わたらまばなかがさ";
const iRow = "いちりみびにきぎし";
const eRow = "えてれめべねけげせ";
const oRow = "おとろもぼのこごそ";
const honorific: Record<string, string[]> = { "行く": ["いらっしゃる"], "来る": ["いらっしゃる"], "いる": ["いらっしゃる"], "食べる": ["召し上がる"], "飲む": ["召し上がる"], "見る": ["ご覧になる"], "言う": ["おっしゃる"], "する": ["なさる"] };
const humble: Record<string, string[]> = { "行く": ["伺う", "参る"], "来る": ["参る"], "いる": ["おる"], "食べる": ["いただく"], "飲む": ["いただく"], "見る": ["拝見する"], "言う": ["申す", "申し上げる"], "する": ["いたす"] };
function verbBases(word: JapaneseWord, spelling: string) {
  const cls = word.wordClass;
  if (!verbs.includes(cls)) throw new Error("這個形式需要動詞。");
  if (cls === "suru") {
    if (!spelling.endsWith("する")) throw new Error("する動詞必須以する結尾。");
    const root = spelling.slice(0, -2);
    return { stem: root + "し", nai: root + "しない", te: root + "して", ta: root + "した", potential: root + "できる", volitional: root + "しよう", imperative: [root + "しろ", root + "せよ"], ba: root + "すれば", passive: root + "される", causative: root + "させる", causative_passive: root + "させられる" };
  }
  if (cls === "kuru") {
    const kanji = spelling.endsWith("来る");
    if (!kanji && !spelling.endsWith("くる")) throw new Error("来る動詞必須以来る或くる結尾。");
    const root = spelling.slice(0, -2);
    const result = (kana: string) => root + (kanji ? "来" + kana.slice(1) : kana);
    return { stem: result("き"), nai: result("こない"), te: result("きて"), ta: result("きた"), potential: result("こられる"), volitional: result("こよう"), imperative: [result("こい")], ba: result("くれば"), passive: result("こられる"), causative: result("こさせる"), causative_passive: result("こさせられる") };
  }
  if (cls === "ichidan") {
    if (!spelling.endsWith("る")) throw new Error("一段動詞必須以る結尾。");
    const root = spelling.slice(0, -1);
    return { stem: root, nai: root + "ない", te: root + "て", ta: root + "た", potential: root + "られる", volitional: root + "よう", imperative: [root + "ろ", root + "よ"], ba: root + "れば", passive: root + "られる", causative: root + "させる", causative_passive: root + "させられる" };
  }
  const last = spelling.slice(-1); const index = endings.indexOf(last);
  if (index < 0) throw new Error("不是支援的五段動詞結尾。");
  const root = spelling.slice(0, -1);
  const exceptionalIku = word.reading === "いく" || word.reading.endsWith("いく") && word.dictionary.endsWith("行く");
  const exceptionalU = /(?:問う|請う|乞う)$/.test(word.dictionary);
  const te = root + (exceptionalU ? "うて" : exceptionalIku ? "って" : "うつる".includes(last) ? "って" : "むぶぬ".includes(last) ? "んで" : last === "く" ? "いて" : last === "ぐ" ? "いで" : "して");
  return { stem: root + iRow[index], nai: root + aRow[index] + "ない", te, ta: te.slice(0, -1) + (te.endsWith("で") ? "だ" : "た"), potential: root + eRow[index] + "る", volitional: root + oRow[index] + "う", imperative: [root + eRow[index]], ba: root + eRow[index] + "ば", passive: root + aRow[index] + "れる", causative: root + aRow[index] + "せる", causative_passive: root + aRow[index] + "せられる" };
}
function inflectVerb(word: JapaneseWord, spelling: string, form: string): string[] {
  const b = verbBases(word, spelling);
  const honorificStem = word.wordClass === "godan" && ["いらっしゃる", "おっしゃる", "くださる", "なさる", "ござる"].includes(word.reading);
  const politeStem = honorificStem ? spelling.slice(0, -1) + "い" : b.stem;
  switch (form) {
    case "dictionary": case "plain_present_positive": return [spelling];
    case "stem": return [politeStem];
    case "te": return [b.te];
    case "ta": case "plain_past_positive": return [b.ta];
    case "nai": case "plain_present_negative": return [b.nai];
    case "plain_past_negative": return [b.nai.slice(0, -1) + "かった"];
    case "polite_present_positive": return [politeStem + "ます"];
    case "polite_present_negative": return [politeStem + "ません"];
    case "polite_past_positive": return [politeStem + "ました"];
    case "polite_past_negative": return [politeStem + "ませんでした"];
    case "potential": return [b.potential]; case "volitional": return [b.volitional];
    case "polite_volitional": return [politeStem + "ましょう"];
    case "imperative": return honorificStem && word.reading !== "ござる" ? [politeStem] : b.imperative; case "prohibition": return [spelling + "な"];
    case "ba": return [b.ba]; case "negative_ba": return [b.nai.slice(0, -1) + "ければ"];
    case "tara": return [b.ta + "ら"]; case "negative_tara": return [b.nai.slice(0, -1) + "かったら"];
    case "passive": return [b.passive]; case "causative": return [b.causative];
    case "causative_passive": return [b.causative_passive, ...(word.wordClass === "godan" && !spelling.endsWith("す") ? [b.causative_passive.replace(/せられる$/, "される")] : [])];
    case "te_ru": return [b.te + "る"];
    case "chau": return [b.te.slice(0, -1) + (b.te.endsWith("で") ? "じゃう" : "ちゃう")];
    case "nakya": return [b.nai.slice(0, -1) + "きゃ"];
  }
  const derivedMatch = form.match(/^(potential|passive|causative|causative_passive)__(.+)$/);
  if (derivedMatch) return inflectVerb(word, spelling, derivedMatch[1]).flatMap(value => inflectVerb({ ...word, wordClass: "ichidan" }, value, derivedMatch[2]));
  const compoundMatch = form.match(/^(te_iru|te_aru|te_oku|te_shimau|te_miru)_(plain|polite)_(present|past)_(positive|negative)$/);
  if (compoundMatch) {
    const aux = { te_iru: ["いる", "ichidan"], te_aru: ["ある", "godan"], te_oku: ["おく", "godan"], te_shimau: ["しまう", "godan"], te_miru: ["みる", "ichidan"] } as const;
    const [base, cls] = aux[compoundMatch[1] as keyof typeof aux];
    // ある negative is ない, not あらない.
    const suffix = compoundMatch.slice(2).join("_");
    const endings = base === "ある" && suffix === "plain_present_negative" ? ["ない"] : base === "ある" && suffix === "plain_past_negative" ? ["なかった"] : inflectVerb({ dictionary: base, reading: base, wordClass: cls, meaning: "補助動詞" }, base, suffix);
    return endings.map(ending => b.te + ending);
  }
  throw new Error("此動詞不支援這個形式。");
}
function inflectNominal(word: JapaneseWord, spelling: string, form: string): string[] {
  const i = word.wordClass === "i_adjective";
  const irregularIi = word.dictionary === "いい" || /(?:がいい|かっこいい|格好いい|気持ちいい)$/.test(word.dictionary);
  const root = i ? irregularIi && spelling.endsWith("いい") ? spelling.slice(0, -2) + "よ" : spelling.slice(0, -1) : spelling;
  const negative = i ? root + "くない" : spelling + "ではない";
  switch (form) {
    case "plain_present_positive": return [i ? spelling : spelling + "だ"];
    case "plain_present_negative": return [negative, ...(!i ? [spelling + "じゃない"] : [])];
    case "plain_past_positive": return [root + (i ? "かった" : "だった")];
    case "plain_past_negative": return [negative.slice(0, -1) + "かった", ...(!i ? [spelling + "じゃなかった"] : [])];
    case "polite_present_positive": return [spelling + "です"];
    case "polite_present_negative": return i ? [root + "くないです", root + "くありません"] : [spelling + "ではありません", spelling + "じゃありません", spelling + "ではないです", spelling + "じゃないです"];
    case "polite_past_positive": return [root + (i ? "かったです" : "でした")];
    case "polite_past_negative": return i ? [root + "くなかったです", root + "くありませんでした"] : [spelling + "ではありませんでした", spelling + "じゃありませんでした", spelling + "ではなかったです", spelling + "じゃなかったです"];
    case "te": return [root + (i ? "くて" : "で")];
    case "ba": return [root + (i ? "ければ" : "であれば")];
    case "negative_ba": return [negative.slice(0, -1) + "ければ", ...(!i ? [spelling + "じゃなければ"] : [])];
    case "tara": return [root + (i ? "かったら" : "だったら")];
    case "negative_tara": return [negative.slice(0, -1) + "かったら", ...(!i ? [spelling + "じゃなかったら"] : [])];
    case "adverbial": return [root + (i ? "く" : "に")];
    case "attributive": return [spelling + (i ? "" : word.wordClass === "noun" ? "の" : "な")];
  }
  throw new Error("此詞類不支援這個形式。");
}
export function conjugateJapanese(word: JapaneseWord, form: string): { answers: string[]; kanaAnswers: string[] } {
  const def = JAPANESE_FORMS.find(f => f.id === form);
  if (!def || !def.classes.includes(word.wordClass)) throw new Error("這個詞類不支援指定形式。");
  const inflect = (value: string) => verbs.includes(word.wordClass) ? inflectVerb(word, value, form) : inflectNominal(word, value, form);
  if (form === "honorific" || form === "humble") {
    const answers = (form === "honorific" ? honorific : humble)[word.dictionary];
    if (!answers) throw new Error("這個動詞尚未收錄常用特殊敬語，不能機械產生。");
    return { answers, kanaAnswers: [] };
  }
  if (word.wordClass === "godan" && word.dictionary === "ある" && ["nai", "plain_present_negative", "plain_past_negative", "negative_ba", "negative_tara", "nakya"].includes(form)) {
    const answer = { nai: "ない", plain_present_negative: "ない", plain_past_negative: "なかった", negative_ba: "なければ", negative_tara: "なかったら", nakya: "なきゃ" }[form]!;
    return { answers: [answer], kanaAnswers: [answer] };
  }
  return { answers: [...new Set(inflect(word.dictionary))], kanaAnswers: [...new Set(inflect(word.reading))] };
}
