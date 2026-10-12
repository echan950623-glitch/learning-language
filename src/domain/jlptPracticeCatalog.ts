import type { CatalogEntry } from "./japanesePracticeCatalog";
import { JLPT_GRAMMAR_CATALOG } from "./jlptGrammarCatalog";
import { JLPT_READING_CATALOG } from "./jlptReadingCatalog";
import { jlptChoice, jlptPack } from "./jlptContentHelpers";

/** Original preparation material; level assignments are editorial, not an official syllabus. */
export type JlptLevel = "N5" | "N4";
export const JLPT_SOURCES = {
  formats: "https://www.jlpt.jp/e/guideline/testsections.html",
  workbooks: "https://www.jlpt.jp/e/samples/sampleindex.html",
  samples: "https://www.jlpt.jp/e/samples/sample09.html",
  faq: "https://www.jlpt.jp/e/faq/",
} as const;

type Word = [level: JlptLevel, word: string, kana: string, meaning: string, sentence: string, wrongReadings: [string, string, string], wrongSpellings: [string, string, string]];
export const JLPT_WORDS: Word[] = [
  ["N5", "毎朝", "まいあさ", "每天早上", "毎朝、六時に起きます。", ["まいひる", "まいばん", "まいにち"], ["毎晩", "毎日", "毎週"]],
  ["N5", "先週", "せんしゅう", "上週", "先週、京都へ行きました。", ["せんげつ", "らいしゅう", "こんしゅう"], ["来週", "今週", "先月"]],
  ["N5", "時間", "じかん", "時間", "駅まで一時間かかります。", ["じけん", "しかん", "じげん"], ["時聞", "寺間", "持間"]],
  ["N5", "入口", "いりぐち", "入口", "入口は右にあります。", ["でぐち", "はいぐち", "いりくち"], ["出口", "入日", "人ロ"]],
  ["N5", "出口", "でぐち", "出口", "出口で友達を待ちます。", ["いりぐち", "でくち", "しゅっこう"], ["入口", "出日", "外口"]],
  ["N5", "切符", "きっぷ", "車票", "駅で切符を買いました。", ["きぷ", "きっふ", "きりふ"], ["切付", "切府", "切布"]],
  ["N5", "病院", "びょういん", "醫院", "熱があるので病院へ行きます。", ["びよういん", "びょいん", "びょうえん"], ["病員", "病園", "美容院"]],
  ["N5", "薬", "くすり", "藥", "ご飯の後で薬を飲みます。", ["くすい", "くずり", "くしり"], ["楽", "葉", "草"]],
  ["N5", "近い", "ちかい", "近的", "私の家は駅に近いです。", ["とおい", "ちがい", "きんい"], ["遠い", "違い", "近かい"]],
  ["N5", "重い", "おもい", "重的", "このかばんは重いです。", ["かるい", "おおい", "おもたい"], ["軽い", "思い", "多い"]],
  ["N5", "教室", "きょうしつ", "教室", "教室で日本語を勉強します。", ["きょしつ", "きょうじつ", "きょうせつ"], ["教屋", "教家", "校室"]],
  ["N5", "天気", "てんき", "天氣", "今日は天気がいいです。", ["でんき", "てんぎ", "ていき"], ["電気", "天汽", "大気"]],
  ["N4", "予約", "よやく", "預約", "電話でホテルを予約しました。", ["ようやく", "よやっく", "ゆやく"], ["予役", "預約", "予訳"]],
  ["N4", "予定", "よてい", "預定安排", "明日の予定を教えてください。", ["よでい", "ようてい", "よて"], ["予足", "預定", "予提"]],
  ["N4", "準備", "じゅんび", "準備", "旅行の準備をしています。", ["じゅび", "しゅんび", "じゅんぴ"], ["準部", "順備", "準費"]],
  ["N4", "連絡", "れんらく", "聯絡", "遅れるときは先生に連絡してください。", ["れいらく", "れんがく", "れんろく"], ["連落", "連路", "練絡"]],
  ["N4", "説明", "せつめい", "說明", "先生が使い方を説明しました。", ["せつまい", "せっめい", "ぜつめい"], ["説名", "設明", "節明"]],
  ["N4", "案内", "あんない", "引導／帶路", "友達に町を案内しました。", ["あない", "あんねい", "あんがい"], ["安内", "案外", "安奈"]],
  ["N4", "受付", "うけつけ", "接待處／受理", "受付で名前を書いてください。", ["うけづけ", "うけつき", "じゅふ"], ["受村", "授付", "受附所"]],
  ["N4", "住所", "じゅうしょ", "地址", "ここに住所を書いてください。", ["じゅしょ", "じゅうじょ", "じゅうそう"], ["住折", "注所", "住署"]],
  ["N4", "都合", "つごう", "時間安排是否方便", "土曜日は都合が悪いです。", ["とごう", "つこう", "つご"], ["都号", "通合", "都会"]],
  ["N4", "用事", "ようじ", "要辦的事情", "用事があるので先に帰ります。", ["よじ", "ようし", "ゆうじ"], ["用時", "用字", "用寺"]],
  ["N4", "約束", "やくそく", "約定", "友達との約束を守ります。", ["やっそく", "やくぞく", "やくそ"], ["約足", "役束", "約速"]],
  ["N4", "経験", "けいけん", "經驗", "外国で働いた経験があります。", ["けけん", "けいげん", "けいきん"], ["経検", "経険", "軽験"]],
  ["N4", "必要", "ひつよう", "必要", "この手続きには写真が必要です。", ["ひちよう", "ひっよう", "ひつよ"], ["必腰", "必容", "必洋"]],
  ["N4", "残念", "ざんねん", "遺憾／可惜", "会えなくて残念です。", ["さんねん", "ざねん", "ざんにん"], ["残年", "残心", "浅念"]],
  ["N4", "安全", "あんぜん", "安全", "ここは安全な場所です。", ["あんせん", "あぜん", "あんざん"], ["安前", "安然", "案全"]],
  ["N4", "危険", "きけん", "危險", "この道は夜、危険です。", ["きげん", "ぎけん", "きかん"], ["危検", "危験", "気険"]],
  ["N4", "故障", "こしょう", "故障", "エアコンが故障しました。", ["ごしょう", "こしょ", "こじょう"], ["故傷", "古障", "故章"]],
  ["N4", "運転", "うんてん", "駕駛", "兄は毎日車を運転します。", ["うてん", "うんでん", "うんて"], ["運伝", "運点", "雲転"]],
  ["N4", "出発", "しゅっぱつ", "出發", "バスは九時に出発します。", ["しゅはつ", "しゅっぱち", "しゅうはつ"], ["出髪", "出登", "出溌"]],
  ["N4", "到着", "とうちゃく", "抵達", "飛行機は十時に到着しました。", ["とちゃく", "とうじゃく", "どうちゃく"], ["到者", "倒着", "到箸"]],
  ["N4", "乗り換え", "のりかえ", "轉乘", "次の駅で乗り換えをします。", ["のりがえ", "のりかわ", "のるかえ"], ["乗り帰え", "乗り買え", "乗り返え"]],
  ["N4", "招待", "しょうたい", "邀請", "友達を家に招待しました。", ["しょたい", "じょうたい", "しょうだい"], ["招侍", "紹待", "昭待"]],
  ["N4", "相談", "そうだん", "商量／諮詢", "進学について先生に相談しました。", ["そだん", "そうたん", "ぞうだん"], ["想談", "相淡", "相段"]],
  ["N4", "復習", "ふくしゅう", "複習", "寝る前に今日の授業を復習します。", ["ふくじゅう", "ふくしょう", "ふっしゅう"], ["復修", "複習", "服習"]],
  ["N4", "間違い", "まちがい", "錯誤", "答えに間違いがありました。", ["まじがい", "まちかい", "まちがえ"], ["問違い", "間偉い", "間遣い"]],
  ["N4", "忘れ物", "わすれもの", "遺忘的物品", "電車に忘れ物をしました。", ["わすもの", "わすれもん", "わずれもの"], ["忘れ者", "忘物れ", "忙れ物"]],
  ["N4", "遅れる", "おくれる", "遲到／延誤", "電車が遅れて、授業に間に合いませんでした。", ["おこれる", "おくる", "おぐれる"], ["送れる", "後れるる", "遅られる"]],
  ["N4", "直す", "なおす", "修理／改正", "作文の間違いを直します。", ["のうす", "なす", "なおる"], ["治す", "真す", "直おす"]],
  ["N4", "選ぶ", "えらぶ", "選擇", "好きな色を選んでください。", ["えぶ", "えらぷ", "ならぶ"], ["選らぶ", "択ぶ", "選む"]],
];

function vocabularyCatalog(): CatalogEntry[] {
  return JLPT_WORDS.map(([level, word, kana, meaning, sentence, readings, spellings], index) => {
    const slot = index % 4;
    const options = (answer: string, wrong: string[]): [string, string, string, string] => { const values = [...wrong]; values.splice(slot, 0, answer); return values as [string, string, string, string]; };
    const wrongMeanings = JLPT_WORDS.filter(w => w[3] !== meaning).slice((index + 1) % 20, (index + 1) % 20 + 3).map(w => w[3]);
    return jlptPack(level, `word:${word}`, `文字語彙：${word}（${kana}）`, "collocation", [
      jlptChoice("reading", `「${word}」の読み方はどれですか。`, options(kana, readings), slot, `${word}讀作${kana}，意思是「${meaning}」。${sentence}`, undefined, "vocabulary"),
      jlptChoice("orthography", `「${kana}」（${meaning}）を漢字でどう書きますか。`, options(word, spellings), slot, `正確寫法是${word}。注意字形與同音詞；例句：${sentence}`, undefined, "vocabulary"),
      jlptChoice("meaning", `例文の「${word}」はどんな意味ですか。`, options(meaning, wrongMeanings), slot, `此處${word}表示「${meaning}」。這題是繁中詞義複習，不是正式日文近義句題型。`, sentence, "vocabulary"),
    ].map(v => ({ ...v, contentKey: `ja-word:${word}:${kana}` })), "漢字讀音、漢字寫法與繁中詞義分開複習。");
  });
}

export function getJlptPracticeCatalog(): CatalogEntry[] {
  return [...vocabularyCatalog(), ...JLPT_GRAMMAR_CATALOG, ...JLPT_READING_CATALOG];
}

// The existing MCP accepts at most 20 concepts per batch. These are preview payloads,
// not backup files, and contain neither confirm=true nor fabricated learning evidence.
export function buildJlptPreviewBatches(level: JlptLevel, learnedConfirmed = false) {
  const entries = getJlptPracticeCatalog().filter(e => e.practice.conceptKey.startsWith(`jlpt:${level.toLowerCase()}:`));
  return Array.from({ length: Math.ceil(entries.length / 20) }, (_, i) => ({ items: entries.slice(i * 20, i * 20 + 20).map(e => ({ practice: structuredClone(e.practice), learnedConfirmed })) }));
}
