import { describe, expect, it } from "vitest";
import { romajiMatchesReading, toRomaji } from "./romaji";

describe("toRomaji", () => {
  it("轉換基本假名詞彙", () => {
    expect(toRomaji("ねこ")).toBe("neko");
    expect(toRomaji("いぬ")).toBe("inu");
    expect(toRomaji("こんにちは")).toBe("konnichiha");
  });

  it("促音（っ）讓下一個子音重複一次", () => {
    expect(toRomaji("がっこう")).toBe("gakkou");
    expect(toRomaji("きっぷ")).toBe("kippu");
  });

  it("促音＋ち固定用 t 重複（matcha 慣例）", () => {
    expect(toRomaji("まっちゃ")).toBe("matcha");
  });

  it("拗音（ゃゅょ）組合成單一音節", () => {
    expect(toRomaji("しゃしん")).toBe("shashin");
    expect(toRomaji("じゅぎょう")).toBe("jugyou");
    expect(toRomaji("びょういん")).toBe("byouin");
  });

  it("ん 後面不是母音或 y 開頭時直接轉成 n", () => {
    expect(toRomaji("せんせい")).toBe("sensei");
    expect(toRomaji("ほん")).toBe("hon");
  });

  it("ん 後面接母音或 y 開頭時插入撇號消歧義", () => {
    expect(toRomaji("きんようび")).toBe("kin'youbi");
    expect(toRomaji("れんあい")).toBe("ren'ai");
  });

  it("片假名先轉平假名再轉羅馬拼音，結果與平假名版本一致", () => {
    expect(toRomaji("センセイ")).toBe(toRomaji("せんせい"));
    expect(toRomaji("ネコ")).toBe("neko");
  });

  it("片假名長音記號（ー）重複前一個母音", () => {
    expect(toRomaji("コーヒー")).toBe("koohii");
  });

  it("外來語常見的小字母音組合（ティ／ファ／ウィ／ヴァ）視為一個音節", () => {
    expect(toRomaji("パーティー")).toBe("paatii");
    expect(toRomaji("ファイル")).toBe("fairu");
    expect(toRomaji("ウィキ")).toBe("wiki");
  });

  it("沒有對應組合規則的小字母音安全退化成獨立母音，不洩漏原始假名字元", () => {
    // ぬ 不在 COMBO_BASE，後面的 small ぃ 應該退化成獨立的 "i"，而不是原樣保留片假名字元。
    expect(toRomaji("ぬぃ")).toBe("nui");
  });

  it("不認得的字元（漢字、標點、既有羅馬字）原樣保留，不拋出例外", () => {
    expect(toRomaji("Wi-Fi")).toBe("Wi-Fi");
    expect(toRomaji("先生")).toBe("先生");
    expect(() => toRomaji("")).not.toThrow();
    expect(toRomaji("")).toBe("");
  });

  it("同樣輸入永遠得到同樣輸出（確定性，非隨機）", () => {
    const results = Array.from({ length: 5 }, () => toRomaji("がっこう"));
    expect(new Set(results).size).toBe(1);
  });
});

describe("romajiMatchesReading", () => {
  it("一致時回傳 true（忽略大小寫與前後空白）", () => {
    expect(romajiMatchesReading("ねこ", "neko")).toBe(true);
    expect(romajiMatchesReading("ねこ", "Neko")).toBe(true);
    expect(romajiMatchesReading("ねこ", "  NEKO  ")).toBe(true);
  });

  it("不一致時回傳 false", () => {
    expect(romajiMatchesReading("ねこ", "inu")).toBe(false);
    expect(romajiMatchesReading("きんようび", "kinyoubi")).toBe(false);
  });
});
