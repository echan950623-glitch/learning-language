import { conjugateJapanese, JAPANESE_FORMS, type JapaneseWord } from "./japaneseConjugation";
import type { LearningPractice, PracticeVariant } from "./learningPractice";
import { getJlptPracticeCatalog } from "./jlptPracticeCatalog";

export const PRACTICE_WORDS: JapaneseWord[] = [
  ["払う", "はらう", "godan", "付款"], ["待つ", "まつ", "godan", "等待"], ["帰る", "かえる", "godan", "回去"],
  ["読む", "よむ", "godan", "閱讀"], ["遊ぶ", "あそぶ", "godan", "玩"], ["死ぬ", "しぬ", "godan", "死亡"],
  ["書く", "かく", "godan", "寫"], ["泳ぐ", "およぐ", "godan", "游泳"], ["話す", "はなす", "godan", "說話"],
  ["行く", "いく", "godan", "去"], ["混む", "こむ", "godan", "擁擠"], ["食べる", "たべる", "ichidan", "吃"],
  ["見る", "みる", "ichidan", "看"], ["片付ける", "かたづける", "ichidan", "收拾"],
  ["する", "する", "suru", "做"], ["来る", "くる", "kuru", "來"],
  ["高い", "たかい", "i_adjective", "昂貴／高"], ["忙しい", "いそがしい", "i_adjective", "忙碌"], ["いい", "いい", "i_adjective", "好"],
  ["静か", "しずか", "na_adjective", "安靜"], ["便利", "べんり", "na_adjective", "方便"], ["元気", "げんき", "na_adjective", "有精神"],
  ["学生", "がくせい", "noun", "學生"], ["先生", "せんせい", "noun", "老師"], ["休み", "やすみ", "noun", "休息／假日"],
].map(([dictionary, reading, wordClass, meaning]) => ({ dictionary, reading, wordClass: wordClass as JapaneseWord["wordClass"], meaning }));
const classLabels: Record<JapaneseWord["wordClass"], string> = { godan: "五段／第一類", ichidan: "一段／第二類", suru: "する／第三類", kuru: "来る／第三類", i_adjective: "い形容詞", na_adjective: "な形容詞", noun: "名詞" };
export interface CatalogEntry { id: string; title: string; category: string; description: string; practice: LearningPractice }
export function conjugationCatalog(words: JapaneseWord[] = PRACTICE_WORDS): CatalogEntry[] {
  return JAPANESE_FORMS.map(form => {
    const variants: PracticeVariant[] = [];
    for (const word of words) {
      if (!form.classes.includes(word.wordClass)) continue;
      if (form.id.startsWith("te_aru") && !["払う", "書く", "片付ける"].includes(word.dictionary)) continue;
      try {
        const result = conjugateJapanese(word, form.id);
        variants.push({ id: `${form.id}:${word.dictionary}`, prompt: `${word.dictionary}（${word.reading}：${word.meaning}）\n請輸入「${form.label}」。`,
          answer: result.answers[0], acceptedAnswers: [...new Set([...result.answers.slice(1), ...result.kanaAnswers])],
          explanation: `${word.dictionary} 是${classLabels[word.wordClass]}。${word.dictionary} → ${result.answers[0]}。${form.explanation}`,
          hint: `詞類：${classLabels[word.wordClass]}。${form.explanation}`, contentKey: `ja-word:${word.dictionary}:${word.reading}`, errorCategory: "form" });
      } catch { /* A missing irregular/honorific is deliberately not guessed. */ }
    }
    return { id: `form:${form.id}:production`, title: form.label, category: form.category, description: form.explanation,
      practice: { version: 1, kind: "conjugation", conceptKey: `form:${form.id}`, title: form.label, capability: "production", learned: false, enabled: false, formId: form.id, variants } } as CatalogEntry;
  }).filter(entry => entry.practice.variants.length > 0);
}
function entry(id: string, title: string, kind: LearningPractice["kind"], capability: LearningPractice["capability"], description: string, variants: PracticeVariant[]): CatalogEntry {
  return { id: `${id}:${capability}`, title, category: { grammar: "文法", particle: "助詞", structure: "句子結構", collocation: "搭配", reading: "閱讀", conjugation: "變化" }[kind], description,
    practice: { version: 1, conceptKey: id, title, kind, capability, learned: false, enabled: false, variants } };
}
const q = (id: string, prompt: string, answer: string, explanation: string, acceptedAnswers: string[] = [], stimulus?: string, errorCategory: PracticeVariant["errorCategory"] = "meaning"): PracticeVariant => ({ id, prompt, answer, explanation, acceptedAnswers, stimulus, errorCategory });
export const TEXT_PRACTICE_CATALOG: CatalogEntry[] = [
  entry("verb:class", "動詞分類：不能只看る結尾", "conjugation", "recognition", "分類答對與能變化分開。使用明確的第一／第二／第三類答案。", [
    q("kaeru", "帰る（かえる）是第一類、第二類還是第三類動詞？", "第一類", "帰る是五段動詞；以る結尾也可能是第一類。", ["五段", "五段動詞"]),
    q("taberu", "食べる（たべる）是第一類、第二類還是第三類動詞？", "第二類", "食べる是一段動詞，變化時去掉る。", ["一段", "一段動詞"]),
    q("suru", "勉強する（べんきょうする）是第一類、第二類還是第三類動詞？", "第三類", "する及其複合動詞屬第三類。", ["する動詞"]),
    q("kuru", "来る（くる）是第一類、第二類還是第三類動詞？", "第三類", "来る屬不規則的第三類。", ["不規則動詞"]),
  ]),
  entry("form:te", "て形規則：分類與接續", "conjugation", "recognition", "只確認是否記得接續規則；自己變得出來要用另外的產出練習。", [
    q("mu", "五段動詞以む結尾時，て形接續是って、んで還是いて？", "んで", "む・ぶ・ぬ結尾改んで。"),
    q("ku", "一般五段動詞以く結尾時，て形接續是って、んで還是いて？（行く除外）", "いて", "一般く結尾改いて；行く是行って。"),
    q("ichidan", "一段動詞做て形時，先去掉哪一個假名再接て？", "る", "一段動詞去掉る後接て。"),
  ]),
  entry("particle:topic", "は／が：主題與未知主語", "particle", "usage", "使用有明確資訊焦點的情境；其他句子中は和が可能都成立，不做一刀切判錯。", [
    q("who", "回答『誰が来ましたか。』，強調新資訊『田中さん』。只填助詞：田中さん＿＿来ました。", "が", "問誰來了，答案的新資訊主語用が。", [], undefined, "particle"),
    q("topic", "開始自我介紹，設定『我』為話題。只填助詞：私＿＿学生です。", "は", "自我介紹以我為話題，用は。", [], undefined, "particle"),
    q("contrast", "明確對比喝與不喝的飲料。只填助詞：コーヒーは飲みますが、お酒＿＿飲みません。", "は", "此題指定對比，所以用は。", [], undefined, "particle"),
  ]),
  entry("grammar:conditional", "と／なら：自然結果與前提", "grammar", "recognition", "條件不只是變出ば／たら；要理解句子如何連接及使用情境。", [
    q("season", "春になると、花が咲きます。\n這裡是：自然反覆結果／接住對方提出的前提？", "自然反覆結果", "此句的と描述季節變化後的自然結果。", ["自然結果"]),
    q("advice", "A：京都に行きます。B：京都に行くなら、この本を持っていくといいですよ。\nなら是：自然反覆結果／接住對方提出的前提？", "接住對方提出的前提", "承接對方說要去京都的前提，再給建議。", ["前提"]),
    q("machine", "このボタンを押すと、ドアが開きます。\n這裡是：固定結果／接住對方提出的前提？", "固定結果", "描述按鈕按下後固定產生的結果。"),
  ]),
  entry("grammar:decision", "ことにする／ことになる：決定來源", "grammar", "recognition", "區分自己做的決定與安排／情勢造成的決定；此練習只測題目指定情境。", [
    q("self", "自分で考えて、毎日日本語を勉強することにしました。\n決定來源：自己決定／外部安排？", "自己決定", "ことにする在此表示自己決定做某事。", ["自己"]),
    q("company", "会社の決定で、来月大阪に転勤することになりました。\n決定來源：自己決定／外部安排？", "外部安排", "会社の決定提供明確情境；ことになった表示已形成的安排。", ["公司安排"]),
    q("class", "先生から連絡があり、試験は来週行うことになりました。\n決定來源：自己決定／外部安排？", "外部安排", "老師通知的考試安排；不是說話者自己決定。", ["老師安排"]),
  ]),
  entry("grammar:you-ni", "ようになる／ようにする：變化與努力", "grammar", "recognition", "能力或習慣的變化，和刻意努力保持某行為分開辨別。", [
    q("ability", "練習して、日本語の新聞が読めるようになりました。\n重點：能力變化／刻意努力？", "能力變化", "読めるようになった表示變得能閱讀。", ["變化"]),
    q("effort", "健康のため、毎日歩くようにしています。\n重點：能力變化／刻意努力？", "刻意努力", "ようにしている表示刻意維持某個行為。", ["努力"]),
    q("habit", "寮に入ってから、早く起きるようになりました。\n重點：習慣變化／刻意努力？", "習慣變化", "以前和現在的習慣不同；這句沒有直接陳述刻意努力。", ["變化"]),
  ]),
  entry("grammar:teiru", "ている：進行與結果狀態", "grammar", "recognition", "相同形式可能表示正在進行或結果狀態，需從情境理解。", [
    q("eating", "今、ご飯を食べています。\n這裡表示：正在進行／結果狀態？", "正在進行", "食べる是動作；今和此句情境表示正在吃飯。", ["進行"]),
    q("married", "田中さんは結婚しています。\n這裡表示：正在進行／結果狀態？", "結果狀態", "結婚している表示已婚狀態，不能一律翻成正在結婚。", ["狀態"]),
    q("open", "窓が開いています。\n這裡表示：正在進行／結果狀態？", "結果狀態", "表示窗戶目前開著；開く之後的狀態仍持續。", ["狀態"]),
  ]),
  entry("grammar:teiru", "ている：情境接續", "grammar", "usage", "練習清楚指定的情境與語體；不使用含糊的自由翻譯評分。", [
    q("read", "情境：現在正在看書，禮貌體。只填空格。\n今、本を＿＿。使用「読む」。", "読んでいます", "読む → 読んで，再接います。", ["よんでいます"], undefined, "attachment"),
    q("clean", "情境：昨天八點正在收拾房間，禮貌體。只填空格。\n昨日の八時、部屋を＿＿。使用「片付ける」。", "片付けていました", "片付ける → 片付けて，再接過去禮貌體いました。", ["かたづけていました"], undefined, "attachment"),
    q("crowded", "情境：道路現在很擁擠，禮貌體。只填空格。\n道が＿＿。使用「混む＋ている」。", "混んでいます", "混む → 混んで；此句描述道路目前擁擠。", ["こんでいます"], undefined, "attachment"),
  ]),
  entry("grammar:experience", "た形＋ことがある", "grammar", "production", "表示過去經驗，前接動詞た形。", [
    q("japan", "曾經去過日本。只填空格。\n日本に＿＿ことがあります。使用「行く」。", "行った", "經驗表達接た形：行く → 行った。", ["いった"], undefined, "attachment"),
    q("sushi", "曾經吃過壽司。只填空格。\n寿司を＿＿ことがあります。使用「食べる」。", "食べた", "食べる → 食べた，再接ことがあります。", ["たべた"], undefined, "attachment"),
    q("kyoto", "曾經住過京都。只填空格。\n京都に＿＿ことがあります。使用「住む」。", "住んだ", "住む → 住んだ，再接ことがあります。", ["すんだ"], undefined, "attachment"),
  ]),
  entry("grammar:obligation", "ない形＋なければならない", "grammar", "usage", "必要／義務；先產生ない形，再把ない改なければならない。", [
    q("pay", "禮貌地表示必須付款。只填空格。\nお金を＿＿。使用「払う＋なければなりません」。", "払わなければなりません", "払う → 払わない → 払わなければなりません。", ["はらわなければなりません"], undefined, "attachment"),
    q("go", "禮貌地表示必須去。只填空格。\n学校に＿＿。使用「行く＋なければなりません」。", "行かなければなりません", "行く → 行かない → 行かなければなりません。", ["いかなければなりません"], undefined, "attachment"),
    q("clean", "禮貌地表示必須收拾。只填空格。\n部屋を＿＿。使用「片付ける＋なければなりません」。", "片付けなければなりません", "片付ける → 片付けない → 片付けなければなりません。", ["かたづけなければなりません"], undefined, "attachment"),
  ]),
  entry("particle:location", "に／で：動作與存在場所", "particle", "usage", "動作發生的場所用で，存在的場所用に；不能只按中文『在』選助詞。", [
    q("study", "只填助詞：図書館＿＿勉強します。", "で", "勉強する的動作場所用で。", [], undefined, "particle"),
    q("live", "只填助詞：寮＿＿住んでいます。", "に", "住む的居住地用に。", [], undefined, "particle"),
    q("exist", "只填助詞：机の上＿＿本があります。", "に", "存在場所用に。", [], undefined, "particle"),
  ]),
  entry("particle:transitivity", "自他動詞：増える／増やす", "particle", "usage", "自然增加與把數量增加的句子角色不同。", [
    q("increase", "只填助詞：学生の数＿＿増えました。", "が", "増える是自動詞，增加的數量是主語，用が。", [], undefined, "particle"),
    q("increase-object", "只填助詞：学校は授業の数＿＿増やしました。", "を", "増やす是他動詞，被增加的數量用を。", [], undefined, "particle"),
    q("open-object", "只填助詞：田中さんが窓＿＿開けました。", "を", "開ける是他動詞，窗戶是動作對象。", [], undefined, "particle"),
  ]),
  entry("structure:modifier", "修飾句：找核心名詞", "structure", "recognition", "先找被修飾的名詞，再辨認前面的修飾範圍。", [
    q("person", "私が昨日駅で会った人\n被修飾的核心名詞是什麼？只輸入日文名詞。", "人", "核心是人；私が昨日駅で会った整段修飾人。", ["ひと"], undefined, "structure"),
    q("book", "先生が勧めてくれた本\n被修飾的核心名詞是什麼？只輸入日文名詞。", "本", "核心是本；先生が勧めてくれた說明是哪一本書。", ["ほん"], undefined, "structure"),
    q("room", "窓が大きい部屋\n被修飾的核心名詞是什麼？只輸入日文名詞。", "部屋", "核心是部屋；窓が大きい修飾部屋。", ["へや"], undefined, "structure"),
  ]),
  entry("structure:order", "句子重組：基本句子", "structure", "production", "依指定順序重組，避免多種合理語序被誤判；標點可省略。", [
    q("school", "以『私は』開頭，依『交通方式→目的地→動詞』排列：\n学校に／私は／行きます／電車で", "私は電車で学校に行きます", "電車で表示交通方式，学校に表示目的地。", ["私は電車で学校に行きます。"], undefined, "structure"),
    q("book", "以『昨日』開頭，依『時間→主題→場所→受詞→動詞』排列：\n本を／読みました／私は／昨日／図書館で", "昨日私は図書館で本を読みました", "時間、主題、場所、受詞都放在動詞前。", ["昨日私は図書館で本を読みました。"], undefined, "structure"),
    q("dorm", "以『私は』開頭，依『主題→同伴→受詞→動詞』排列：\n片付けました／友達と／私は／部屋を", "私は友達と部屋を片付けました", "友達と表示同伴，部屋を是動作對象。", ["私は友達と部屋を片付けました。"], undefined, "structure"),
  ]),
  entry("collocation:yakusoku", "約束：常見搭配", "collocation", "usage", "同一個字在不同情境使用不同搭配。", [
    q("keep", "履行約定：只填動詞辭書形。\n約束を＿＿。", "守る", "約束を守る＝履行、遵守約定。", ["まもる"], undefined, "vocabulary"),
    q("break", "違反約定：只填動詞辭書形。\n約束を＿＿。", "破る", "約束を破る＝違反約定。", ["やぶる"], undefined, "vocabulary"),
    q("make", "作出約定：只填動詞辭書形。\n約束を＿＿。", "する", "約束をする＝作出約定。", [], undefined, "vocabulary"),
  ]),
  entry("reading:daily", "短文閱讀：原因與行動", "reading", "recognition", "先讀文章再回答；不在作答前顯示翻譯和解析。", [
    q("traffic", "小林さん為什麼改搭電車？請用中文回答主要原因。", "道路塞車", "文章中的でも引出交通障礙；改搭電車的原因是道路塞車。", ["塞車", "道路擁擠", "渋滞", "道が混んでいたから"], "小林さんは友達と映画を見る約束をしていました。車で駅へ行くつもりでした。でも、道が混んでいたので、電車で行きました。"),
    q("match", "為什麼比賽延到下週？請用中文回答主要原因。", "下雨", "雨が降ったので表示延期的原因；不是因為有人受傷。", ["因為下雨", "雨天", "雨が降ったから"], "今日は試合の日でした。しかし、朝から雨が降ったので、試合は来週になりました。選手は寮で練習の予定を相談しました。"),
    q("room", "整理房間後，田中さん找到什麼？請輸入日文名詞。", "鍵", "掃除中に鍵を見つけた，找到的是鑰匙。", ["かぎ", "カギ"], "田中さんは部屋を片付けました。机の下を掃除しているとき、なくした鍵を見つけました。それから、友達に電話しました。"),
  ]),
  entry("reading:reference", "文章閱讀：指示詞與主張", "reading", "recognition", "從短文進到稍長文章，辨認指示詞、轉折與作者主張；不以這批素材宣稱達到 N2。", [
    q("reference", "文中的『それ』指什麼？請用中文回答。", "整理房間", "それ承接前句的部屋を片付けた這件事。", ["收拾房間", "片付け", "部屋を片付けたこと"], "昨日、私は部屋を片付けた。それには二時間もかかったが、机が使いやすくなった。"),
    q("claim", "作者最重視哪件事？請用中文回答。", "持續學習", "文章先肯定大量學習，再用しかし指出持續的重要性。", ["每天持續學習", "持續", "続けること"], "一日にたくさん勉強するのは悪いことではありません。しかし、それだけで十分だとは思いません。一度に長く勉強しても、その後何週間も勉強しなければ、覚えたことを忘れてしまいます。短い時間でも毎日続けることが大切です。"),
    q("compare", "兩人中誰建議減少新內容？只輸入姓名。", "田中", "佐藤重視大量新學，田中認為應先複習並減少新增；題目只問誰提減量。", ["田中さん", "たなか"], "佐藤：毎日新しい言葉を二十個覚えたいです。\n田中：新しい言葉も大切ですが、最近習った言葉をよく忘れます。まず復習して、新しい言葉は五個くらいにしたらどうでしょうか。"),
  ]),
];
export function getJapanesePracticeCatalog(): CatalogEntry[] { return [...conjugationCatalog(), ...TEXT_PRACTICE_CATALOG, ...getJlptPracticeCatalog()]; }
