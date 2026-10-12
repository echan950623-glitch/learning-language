import { describe, expect, it } from "vitest";
import { conjugateJapanese, JAPANESE_FORMS, type JapaneseWordClass } from "./japaneseConjugation";
import { getJapanesePracticeCatalog } from "./japanesePracticeCatalog";
import { isLearningPractice } from "./learningPractice";
const answer = (dictionary: string, reading: string, wordClass: JapaneseWordClass, form: string) => conjugateJapanese({ dictionary, reading, wordClass, meaning: "test" }, form);
describe("Japanese forms with independently specified expected answers", () => {
  it.each([
    ["払う", "はらう", "払って", "払った", "払わない"], ["待つ", "まつ", "待って", "待った", "待たない"],
    ["帰る", "かえる", "帰って", "帰った", "帰らない"], ["読む", "よむ", "読んで", "読んだ", "読まない"],
    ["遊ぶ", "あそぶ", "遊んで", "遊んだ", "遊ばない"], ["死ぬ", "しぬ", "死んで", "死んだ", "死なない"],
    ["書く", "かく", "書いて", "書いた", "書かない"], ["泳ぐ", "およぐ", "泳いで", "泳いだ", "泳がない"],
    ["問う", "とう", "問うて", "問うた", "問わない"],
    ["話す", "はなす", "話して", "話した", "話さない"], ["行く", "いく", "行って", "行った", "行かない"],
  ])("handles godan %s without guessing る class", (dictionary, reading, te, ta, nai) => {
    expect(answer(dictionary, reading, "godan", "te").answers).toContain(te);
    expect(answer(dictionary, reading, "godan", "ta").answers).toContain(ta);
    expect(answer(dictionary, reading, "godan", "nai").answers).toContain(nai);
  });
  it.each([
    ["食べる", "たべる", "ichidan", "te", "食べて"], ["片付ける", "かたづける", "ichidan", "nai", "片付けない"],
    ["する", "する", "suru", "te", "して"], ["勉強する", "べんきょうする", "suru", "potential", "勉強できる"],
    ["来る", "くる", "kuru", "stem", "来"], ["来る", "くる", "kuru", "nai", "来ない"], ["来る", "くる", "kuru", "imperative", "来い"],
    ["来る", "くる", "kuru", "te", "来て"], ["来る", "くる", "kuru", "potential", "来られる"],
    ["くださる", "くださる", "godan", "polite_present_positive", "くださいます"],
    ["なさる", "なさる", "godan", "imperative", "なさい"],
    ["いらっしゃる", "いらっしゃる", "godan", "polite_past_negative", "いらっしゃいませんでした"],
    ["かっこいい", "かっこいい", "i_adjective", "plain_past_positive", "かっこよかった"],
    ["かわいい", "かわいい", "i_adjective", "plain_past_positive", "かわいかった"],
    ["読む", "よむ", "godan", "polite_past_negative", "読みませんでした"], ["読む", "よむ", "godan", "plain_past_negative", "読まなかった"],
    ["書く", "かく", "godan", "potential", "書ける"], ["書く", "かく", "godan", "volitional", "書こう"],
    ["書く", "かく", "godan", "polite_volitional", "書きましょう"], ["書く", "かく", "godan", "imperative", "書け"],
    ["書く", "かく", "godan", "prohibition", "書くな"], ["書く", "かく", "godan", "ba", "書けば"],
    ["書く", "かく", "godan", "negative_ba", "書かなければ"], ["書く", "かく", "godan", "tara", "書いたら"],
    ["書く", "かく", "godan", "negative_tara", "書かなかったら"], ["書く", "かく", "godan", "passive", "書かれる"],
    ["書く", "かく", "godan", "causative", "書かせる"], ["書く", "かく", "godan", "causative_passive", "書かせられる"],
    ["書く", "かく", "godan", "causative_passive", "書かされる"], ["書く", "かく", "godan", "potential__polite_past_negative", "書けませんでした"],
    ["食べる", "たべる", "ichidan", "causative", "食べさせる"], ["する", "する", "suru", "causative_passive", "させられる"],
    ["読む", "よむ", "godan", "te_iru_polite_past_negative", "読んでいませんでした"],
    ["書く", "かく", "godan", "te_aru_plain_present_negative", "書いてない"],
    ["書く", "かく", "godan", "te_oku_plain_present_negative", "書いておかない"],
    ["読む", "よむ", "godan", "te_shimau_polite_past_positive", "読んでしまいました"],
    ["食べる", "たべる", "ichidan", "te_miru_plain_past_positive", "食べてみた"],
    ["読む", "よむ", "godan", "te_ru", "読んでる"], ["読む", "よむ", "godan", "chau", "読んじゃう"],
    ["食べる", "たべる", "ichidan", "chau", "食べちゃう"], ["行く", "いく", "godan", "nakya", "行かなきゃ"],
    ["いい", "いい", "i_adjective", "plain_past_positive", "よかった"], ["いい", "いい", "i_adjective", "plain_present_negative", "よくない"],
    ["高い", "たかい", "i_adjective", "te", "高くて"], ["高い", "たかい", "i_adjective", "polite_past_negative", "高くありませんでした"],
    ["静か", "しずか", "na_adjective", "plain_present_positive", "静かだ"], ["静か", "しずか", "na_adjective", "plain_past_negative", "静かじゃなかった"],
    ["静か", "しずか", "na_adjective", "attributive", "静かな"], ["学生", "がくせい", "noun", "attributive", "学生の"],
    ["学生", "がくせい", "noun", "polite_past_positive", "学生でした"], ["静か", "しずか", "na_adjective", "ba", "静かであれば"],
    ["学生", "がくせい", "noun", "negative_tara", "学生ではなかったら"], ["ある", "ある", "godan", "nai", "ない"],
    ["見る", "みる", "ichidan", "honorific", "ご覧になる"], ["する", "する", "suru", "humble", "いたす"],
  ])("%s %s %s %s => %s", (dictionary, reading, cls, form, expected) => {
    expect(answer(dictionary, reading, cls as JapaneseWordClass, form).answers).toContain(expected);
  });
  it("preserves irregular 来る readings", () => {
    expect(answer("来る", "くる", "kuru", "nai").kanaAnswers).toEqual(["こない"]);
    expect(answer("来る", "くる", "kuru", "polite_present_positive").kanaAnswers).toEqual(["きます"]);
  });
  it("rejects unknown forms and unlisted honorifics", () => {
    expect(() => answer("読む", "よむ", "godan", "whatever")).toThrow();
    expect(() => answer("払う", "はらう", "godan", "humble")).toThrow();
    expect(() => answer("静か", "しずか", "na_adjective", "passive")).toThrow();
  });
  it("catalog covers each advertised form, starts unlearned and has distinct questions", () => {
    const catalog = getJapanesePracticeCatalog();
    expect(new Set(JAPANESE_FORMS.map(f => f.id)).size).toBe(JAPANESE_FORMS.length);
    for (const form of JAPANESE_FORMS) expect(catalog.some(e => e.practice.formId === form.id)).toBe(true);
    for (const entry of catalog) {
      expect(isLearningPractice(entry.practice)).toBe(true);
      expect(entry.practice.learned).toBe(false); expect(entry.practice.enabled).toBe(false);
      expect(entry.practice.variants.length).toBeGreaterThanOrEqual(3);
    }
  });
});
