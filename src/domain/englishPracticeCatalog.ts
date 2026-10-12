import type { NewLearningItemInput } from "./types";

type Entry = [string, string, string, string, string[]];
// Original starter material. Each entry teaches one sense, not every meaning of a word.
const entries: Entry[] = [
  ["available", "可用的；有空的", "形容詞", "日常", ["Is this room available?|這個房間可以使用嗎？", "Are you available tomorrow?|你明天有空嗎？", "The guide is available online.|這份指南可以在線上取得。", "A free account is available.|可以申請免費帳戶。"]],
  ["confirm", "確認", "動詞", "日常", ["Please confirm your name.|請確認你的姓名。", "Can you confirm the date?|你可以確認日期嗎？", "We need to confirm the address.|我們需要確認地址。", "Please confirm your account details.|請確認你的帳戶資料。"]],
  ["arrange", "安排", "動詞", "日常", ["I will arrange a meeting.|我會安排一場會議。", "Can you arrange a taxi?|你能安排一輛計程車嗎？", "We can arrange a visit.|我們可以安排一次拜訪。", "Please arrange a short call.|請安排一通簡短的電話。"]],
  ["delay", "延誤；延遲", "名詞", "日常", ["There is a short delay.|有一段短暫的延誤。", "The flight has a two-hour delay.|這班飛機延誤兩小時。", "Sorry for the delay.|抱歉耽擱了。", "A network delay caused the problem.|網路延遲造成了這個問題。"]],
  ["request", "請求；申請", "名詞", "日常", ["We received your request.|我們收到了你的請求。", "Please send a written request.|請提出書面申請。", "Your request is under review.|你的申請正在審查中。", "The server received a request.|伺服器收到了一個請求。"]],
  ["provide", "提供", "動詞", "日常", ["We provide free water.|我們提供免費的水。", "Please provide your address.|請提供你的地址。", "They provide training.|他們提供訓練。", "Can you provide more details?|你能提供更多細節嗎？"]],
  ["cancel", "取消", "動詞", "日常", ["I need to cancel my booking.|我需要取消預訂。", "Please cancel the meeting.|請取消會議。", "You can cancel at any time.|你隨時都可以取消。", "Click here to cancel the request.|按這裡取消請求。"]],
  ["deadline", "截止期限", "名詞", "多益／職場", ["The deadline is Friday.|截止期限是星期五。", "We have a tight deadline.|我們的期限很緊迫。", "Please check the deadline.|請確認截止期限。", "The project deadline has changed.|專案的截止期限改了。"]],
  ["schedule", "時程；行程表", "名詞", "多益／職場", ["Please check the schedule.|請查看行程表。", "My schedule is full today.|我今天的行程排滿了。", "The team shared a new schedule.|團隊分享了新的時程表。", "The test schedule is on the board.|測試時程在看板上。"]],
  ["require", "需要；要求", "動詞", "多益／職場", ["We require a valid ID.|我們要求出示有效證件。", "These tasks require teamwork.|這些任務需要團隊合作。", "Some jobs require experience.|有些工作要求具備經驗。", "Secure systems require regular checks.|安全的系統需要定期檢查。"]],
  ["update", "更新", "動詞", "多益／職場", ["Please update your address.|請更新你的地址。", "We need to update the plan.|我們需要更新計畫。", "You can update your profile.|你可以更新個人資料。", "Please update the software.|請更新軟體。"]],
  ["issue", "問題", "名詞", "多益／職場", ["We found an issue.|我們發現了一個問題。", "Please report this issue.|請回報這個問題。", "The team fixed the issue.|團隊修好了這個問題。", "There is a security issue.|有一個安全問題。"]],
  ["responsible", "負責的", "形容詞", "多益／職場", ["Who is responsible for this task?|誰負責這個任務？", "I am responsible for training.|我負責訓練。", "She is responsible for the budget.|她負責預算。", "Our team is responsible for security.|我們團隊負責安全事務。"]],
  ["attend", "出席；參加", "動詞", "多益／職場", ["Can you attend the meeting?|你能出席會議嗎？", "I will attend the training.|我會參加訓練。", "Many people attend this event.|許多人參加這個活動。", "You can attend the workshop online.|你可以線上參加工作坊。"]],
  ["access", "存取；使用的機會或權限", "名詞", "技術", ["I need access to this file.|我需要能存取這個檔案。", "Guests have limited access.|訪客的存取權限有限。", "You have access to the course.|你可以使用這門課程。", "The account has access to the server.|這個帳戶可以存取伺服器。"]],
  ["permission", "許可；權限", "名詞", "技術", ["You need permission to enter.|你需要取得進入的許可。", "Ask for permission first.|先徵求許可。", "She gave me permission.|她給了我許可。", "Check the file permission.|檢查檔案權限。"]],
  ["account", "帳戶", "名詞", "技術", ["I created a new account.|我建立了新帳戶。", "Your account is ready.|你的帳戶準備好了。", "Please check your account.|請檢查你的帳戶。", "This account has no admin rights.|這個帳戶沒有管理員權限。"]],
  ["secure", "安全的；受保護的", "形容詞", "技術", ["This website is secure.|這個網站是安全的。", "We need a secure connection.|我們需要安全的連線。", "Keep your files in a secure place.|把檔案放在安全的地方。", "The team uses a secure system.|團隊使用受保護的系統。"]],
  ["deploy", "部署", "動詞", "技術", ["We will deploy the app today.|我們今天會部署應用程式。", "Please deploy the latest version.|請部署最新版本。", "You can deploy after testing.|測試後可以部署。", "The team will deploy a security fix.|團隊會部署安全修正。"]],
  ["configure", "設定；配置", "動詞", "技術", ["Please configure the network.|請設定網路。", "We need to configure the server.|我們需要設定伺服器。", "You can configure these options.|你可以設定這些選項。", "The guide explains how to configure access.|指南說明如何設定存取權限。"]],
  ["find out", "查明；得知", "片語動詞", "日常", ["I want to find out the price.|我想查明價格。", "Let's find out what happened.|讓我們查明發生了什麼事。", "You can find out more online.|你可以在線上了解更多。", "We need to find out why it failed.|我們需要找出失敗的原因。"]],
  ["pick up", "取走；領取", "片語動詞", "日常", ["I will pick up my order.|我會領取我的訂單。", "Please pick up your ticket.|請領取你的票。", "You can pick up the keys here.|你可以在這裡領鑰匙。", "I need to pick up a package.|我需要領取包裹。"]],
  ["look for", "尋找", "片語動詞", "日常", ["I will look for my keys.|我會找我的鑰匙。", "Let's look for a quiet room.|我們找個安靜的房間吧。", "You can look for jobs online.|你可以在線上找工作。", "We need to look for the error.|我們需要找出錯誤。"]],
  ["meet a deadline", "如期完成；趕上期限", "固定搭配", "多益／職場", ["We need to meet a deadline.|我們需要如期完成。", "I worked late to meet a deadline.|我為了趕上期限工作到很晚。", "Planning helps us meet a deadline.|規劃有助於我們如期完成。", "The team must meet a deadline this week.|團隊這週必須趕上期限。"]],
  ["be responsible for", "負責某事", "固定搭配", "多益／職場", ["I will be responsible for this task.|我會負責這個任務。", "You will be responsible for training.|你會負責訓練。", "One person should be responsible for the budget.|應由一個人負責預算。", "Our team will be responsible for security.|我們團隊會負責安全事務。"]],
  ["follow up on", "追蹤；跟進某事", "片語動詞", "多益／職場", ["I will follow up on your request.|我會跟進你的請求。", "Please follow up on this issue.|請追蹤這個問題。", "We need to follow up on the order.|我們需要追蹤訂單。", "The team will follow up on the report.|團隊會跟進這份報告。"]],
  ["let someone know", "讓某人知道；通知", "固定表達", "多益／職場", ["Please let me know the date.|請告訴我日期。|let me know", "I will let you know tomorrow.|我明天會通知你。|let you know", "Please let us know about any problems.|有任何問題請通知我們。|let us know", "We should let them know about the change.|我們應該通知他們這項變更。|let them know"]],
  ["access control", "存取控制", "固定搭配", "技術", ["This system uses access control.|這個系統使用存取控制。", "We need better access control.|我們需要更好的存取控制。", "The guide explains access control.|指南解釋了存取控制。", "Please review the access control rules.|請審查存取控制規則。"]],
  ["set up", "建立；設定好", "片語動詞", "技術", ["I will set up a new account.|我會建立新帳戶。", "Please set up the meeting room.|請布置好會議室。", "We need to set up a test server.|我們需要建立測試伺服器。", "You can set up alerts here.|你可以在這裡設定警示。"]],
  ["back up", "備份", "片語動詞", "技術", ["Please back up your files.|請備份你的檔案。", "We back up the data every day.|我們每天備份資料。", "Remember to back up your work.|記得備份你的工作成果。", "You should back up the database first.|你應該先備份資料庫。"]],
];
export function getEnglishPracticeCatalog(): NewLearningItemInput[] {
  return entries.map(([answer, promptZh, partOfSpeech, tag, sentences], index) => {
    const distractors = entries.filter(e => e[1] !== promptZh && e[0] !== answer).slice(index % 15, index % 15 + 3).map(e => e[1]);
    const choices = [promptZh, ...distractors].map((text, n) => ({ id: `c${n}`, text }));
    const rotate = (n: number) => [...choices.slice(n % 4), ...choices.slice(0, n % 4)];
    const senseKey = `en:${answer.replaceAll(" ", "-")}:${partOfSpeech}`;
    return { language: "en", type: index < 20 ? "vocabulary" : partOfSpeech === "固定搭配" ? "collocation" : "phrase", answer, promptZh, partOfSpeech, source: "ai", tags: [tag],
      englishPractice: { version: 1, senseKey, variants: [
        { id: "direct", mode: "direct", targetText: answer, choices: rotate(index), correctChoiceId: "c0", explanationZh: `本項目練習 ${answer} 作為${partOfSpeech}時的「${promptZh}」用法。`, role: "practice", hint: `本次指定詞性：${partOfSpeech}。` },
        ...sentences.map((pair, n) => {
          const [sentence, translationZh, targetText] = pair.split("|");
          return { id: `context-${n + 1}`, mode: "context" as const, sentence, translationZh, targetText: targetText ?? answer, choices: rotate(index + n + 1), correctChoiceId: "c0", explanationZh: `${targetText ?? answer} 在本句表示「${promptZh}」。${translationZh}`, role: n === 3 ? "verification" as const : "practice" as const, hint: "先留意這個表達前後描述的人、事物或動作。" };
        })] } };
  });
}
