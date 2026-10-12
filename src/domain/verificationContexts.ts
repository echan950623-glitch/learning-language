import type { AbilityKind, LearningItem } from "./types";

/** Authored N5/N4 parallel prompts; blanks require the dictionary form, never an inferred conjugation. */
const CONTEXTS: Record<string, [string, string]> = {
  毎朝: ["（　）、学校へ行く前にご飯を食べます。", "私は（　）、七時に起きます。"],
  先週: ["（　）は忙しかったですが、今週は暇です。", "（　）、友達と映画を見ました。"],
  時間: ["今日は勉強する（　）がありません。", "ここから駅まで、どのくらい（　）がかかりますか。"],
  入口: ["店に入る人は、こちらの（　）を使ってください。", "図書館の（　）に地図があります。"],
  出口: ["駅を出たら、（　）の前で待ってください。", "建物から出るときは、右の（　）を使います。"],
  切符: ["電車に乗る前に（　）を買います。", "東京までの（　）を一枚ください。"],
  病院: ["母は熱があるので（　）で診てもらいます。", "この（　）には医者が三人います。"],
  薬: ["医者にもらった（　）を飲みました。", "この（　）は一日に三回飲んでください。"],
  近い: ["駅が（　）ので、歩いて行きます。", "家から（　）店で買い物をします。"],
  重い: ["この箱は（　）ので、一人では持てません。", "（　）荷物を二人で運びます。"],
  教室: ["授業が始まるので（　）に入ってください。", "先生はまだ（　）にいません。"],
  天気: ["明日の（　）がよければ、公園へ行きます。", "旅行の前に、京都の（　）を調べます。"],
  予約: ["この店は（　）が必要です。", "レストランに電話して（　）をしました。"],
  予定: ["来週の（　）はまだ決まっていません。", "日曜日は何か（　）がありますか。"],
  準備: ["試験の（　）を始めましょう。", "出かける（　）ができたら教えてください。"],
  連絡: ["休むときは学校に（　）してください。", "友達から（　）が来るのを待っています。"],
  説明: ["この機械の使い方を（　）してください。", "先生の（　）をよく聞きます。"],
  案内: ["初めて来た人に、学校の中を（　）します。", "駅まで道を（　）してくれました。"],
  受付: ["病院に着いたら、まず（　）へ行ってください。", "（　）で名前を伝えてから待ちます。"],
  住所: ["引っ越したので（　）が変わりました。", "手紙に名前と（　）を書きます。"],
  都合: ["明日は（　）がいいので、会えます。", "ご（　）のいい日を教えてください。"],
  用事: ["銀行に（　）があるので出かけます。", "今日は（　）がないので家にいます。"],
  約束: ["友達と会う（　）をしました。", "大切な（　）を忘れないでください。"],
  経験: ["日本に住んだ（　）はありますか。", "この仕事の（　）はありません。"],
  必要: ["入るときは学生証が（　）です。", "旅行に（　）な物を買います。"],
  残念: ["試合に負けて（　）でした。", "（　）ですが、その日は行けません。"],
  安全: ["子どもが遊べる（　）な場所を探します。", "出発の前に（　）を確認します。"],
  危険: ["川の近くで遊ぶのは（　）です。", "（　）な場所には入らないでください。"],
  故障: ["洗濯機が（　）して、使えません。", "車の（　）を直してもらいます。"],
  運転: ["疲れたときは車の（　）をしません。", "父はバスの（　）が上手です。"],
  出発: ["電車の（　）まで、あと五分です。", "旅行の（　）は明日の朝です。"],
  到着: ["電車の（　）が十分遅れています。", "空港に（　）したら電話してください。"],
  乗り換え: ["この駅で電車の（　）をします。", "東京まで（　）なしで行けます。"],
  招待: ["結婚式に友達を（　）します。", "パーティーに（　）してくれて、ありがとう。"],
  相談: ["困ったときは先生に（　）します。", "家族と（　）してから決めます。"],
  復習: ["試験の前に、教科書を使って（　）します。", "授業の後で（　）をすると、よく覚えられます。"],
  間違い: ["名前に（　）がないか確認してください。", "作文には（　）が三つあります。"],
  忘れ物: ["学校へ行く前に（　）がないか調べます。", "駅で電車の中の（　）を探してもらいました。"],
  遅れる: ["バスが（　）と、授業に間に合いません。", "約束の時間に（　）ことは、よくありません。"],
  直す: ["壊れた時計を（　）ことができますか。", "作文を（　）前に、先生に見てもらいます。"],
  選ぶ: ["プレゼントを（　）のは楽しいです。", "どれを（　）か、まだ決めていません。"],
};

export function vocabularyVerificationQuestions(item: LearningItem, ability: AbilityKind) {
  if (item.language !== "ja" || item.practice || item.type !== "vocabulary") return [];
  return (CONTEXTS[item.answer] ?? []).filter(sentence => sentence !== item.exampleSentence).map((sentence, index) => ({
    key: `context-v1:${item.answer}:${ability}:${index}`,
    prompt: ability === "reading"
      ? `請寫出句中「${item.answer}」的假名讀音。\n${sentence.replace("（　）", `「${item.answer}」`)}`
      : `請用日文填空（詞義：${item.promptZh}；使用原形）。\n${sentence}`,
    sentence,
  }));
}

export function freezeVocabularyVerification(item: LearningItem, ability: AbilityKind, seenKeys: Set<string>) {
  const questions = vocabularyVerificationQuestions(item, ability);
  const question = questions.find(q => !seenKeys.has(q.key)) ?? questions[seenKeys.size % Math.max(1, questions.length)];
  if (!question) return { ...structuredClone(item), promptZh: ability === "reading" ? item.answer : item.promptZh,
    verificationQuestion: { key: `retention:${item.id}:${ability}`, kind: "retention" as const, novel: false, basePrompt: item.promptZh } };
  return { ...structuredClone(item), promptZh: question.prompt, exampleSentence: question.sentence.replace("（　）", item.answer),
    explanation: `句中填入「${item.answer}」：${question.sentence.replace("（　）", item.answer)}` ,
    verificationQuestion: { key: question.key, kind: ability === "recall" ? "context" as const : "retention" as const, novel: !seenKeys.has(question.key), basePrompt: item.promptZh } };
}
