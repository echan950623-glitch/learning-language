import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountSyncPanel } from "./AccountSyncPanel";

describe("account sync entry", () => {
  it("always exposes login before a session has been loaded", () => {
    const html = renderToStaticMarkup(createElement(AccountSyncPanel));
    expect(html).toContain("帳戶與雲端同步");
    expect(html).toContain('href="/auth/sign-in?redirect=%2Fsettings"');
    expect(html).toContain("登入以同步學習紀錄");
  });
});
