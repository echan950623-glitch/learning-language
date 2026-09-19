import { describe, expect, it } from "vitest";

import { AUTH_ERROR_CODES, resolveAuthErrorMessage } from "./errorCodes";

describe("resolveAuthErrorMessage", () => {
  it("每一個固定代碼都對應一句非空的繁體中文訊息", () => {
    for (const code of AUTH_ERROR_CODES) {
      const message = resolveAuthErrorMessage(code);
      expect(typeof message).toBe("string");
      expect(message!.length).toBeGreaterThan(0);
    }
  });

  it("null／undefined／空字串一律回傳 null", () => {
    expect(resolveAuthErrorMessage(null)).toBeNull();
    expect(resolveAuthErrorMessage(undefined)).toBeNull();
    expect(resolveAuthErrorMessage("")).toBeNull();
  });

  it("未知代碼回傳 null，不會把任意字串顯示出來", () => {
    expect(resolveAuthErrorMessage("<script>alert(1)</script>")).toBeNull();
    expect(resolveAuthErrorMessage("some_other_error")).toBeNull();
  });
});
