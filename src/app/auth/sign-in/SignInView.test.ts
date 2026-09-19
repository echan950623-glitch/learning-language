import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SignInView } from "./SignInView";

function firstButtonTag(html: string): string {
  const match = /<button[^>]*>/.exec(html);
  if (!match) throw new Error("找不到任何 <button>，SignInView 的初始渲染結構可能被改壞了");
  return match[0];
}

/** 判斷抓出來的 tag 字串是否帶有真正的 HTML `disabled` 屬性，而不是誤判到
 *  `disabled:opacity-50` 這種 Tailwind class 名稱裡的子字串。 */
function hasDisabledAttribute(tag: string): boolean {
  return /(?:^|\s)disabled(?:=""|(?=\s|>))/.test(tag);
}

describe("SignInView", () => {
  it("Google provider 不可用時，第一顆按鈕（Google 按鈕）必須是 disabled，並誠實顯示尚未啟用", () => {
    const html = renderToStaticMarkup(
      createElement(SignInView, { redirectTo: "/settings", googleAvailable: false, errorMessage: null })
    );

    expect(hasDisabledAttribute(firstButtonTag(html))).toBe(true);
    expect(html).toContain("Google 登入目前尚未啟用");
    expect(html).toContain("使用 Google 登入");
  });

  it("Google provider 可用時，第一顆按鈕不能是 disabled，且顯示「選同一個 Email」的說明", () => {
    const html = renderToStaticMarkup(
      createElement(SignInView, { redirectTo: "/settings", googleAvailable: true, errorMessage: null })
    );

    expect(hasDisabledAttribute(firstButtonTag(html))).toBe(false);
    expect(html).toContain("請選擇與你連結 GPT 時相同的 Google 帳戶");
    expect(html).not.toContain("Google 登入目前尚未啟用");
  });

  it("帶入 errorMessage 時會顯示成 alert；沒有 errorMessage 時完全不出現", () => {
    const withError = renderToStaticMarkup(
      createElement(SignInView, {
        redirectTo: "/settings",
        googleAvailable: true,
        errorMessage: "Google 登入已取消或被拒絕，請重新嘗試，或改用下方 Email 登入連結。",
      })
    );
    expect(withError).toContain('role="alert"');
    expect(withError).toContain("Google 登入已取消或被拒絕");

    const withoutError = renderToStaticMarkup(
      createElement(SignInView, { redirectTo: "/settings", googleAvailable: true, errorMessage: null })
    );
    expect(withoutError).not.toContain("Google 登入已取消或被拒絕");
  });

  it("無論 Google 是否可用，Email 一次性連結的表單一律都在，作為 fallback", () => {
    for (const googleAvailable of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(SignInView, { redirectTo: "/settings", googleAvailable, errorMessage: null })
      );
      expect(html).toContain("寄送登入連結");
      expect(html).toContain('type="email"');
    }
  });

  it("不會渲染 Apple 或密碼登入相關的內容", () => {
    const html = renderToStaticMarkup(
      createElement(SignInView, { redirectTo: "/settings", googleAvailable: true, errorMessage: null })
    );
    expect(html).not.toContain("Apple");
    expect(html).not.toContain('type="password"');
  });
});
