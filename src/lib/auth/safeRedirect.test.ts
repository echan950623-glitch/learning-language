import { describe, expect, it } from "vitest";

import { buildAuthCallbackUrl, DEFAULT_REDIRECT_PATH, resolveSafeRedirect } from "./safeRedirect";

describe("resolveSafeRedirect", () => {
  it("沒有帶值時回傳預設值 /settings", () => {
    expect(resolveSafeRedirect(null)).toBe("/settings");
    expect(resolveSafeRedirect(undefined)).toBe("/settings");
    expect(resolveSafeRedirect("")).toBe("/settings");
    expect(DEFAULT_REDIRECT_PATH).toBe("/settings");
  });

  it("允許自訂 fallback", () => {
    expect(resolveSafeRedirect(null, "/")).toBe("/");
  });

  it("接受單一前導斜線的站內路徑", () => {
    expect(resolveSafeRedirect("/settings")).toBe("/settings");
    expect(resolveSafeRedirect("/progress")).toBe("/progress");
  });

  it("保留 query string 與 hash", () => {
    expect(resolveSafeRedirect("/oauth/consent?authorization_id=abc")).toBe(
      "/oauth/consent?authorization_id=abc"
    );
    expect(resolveSafeRedirect("/settings#account")).toBe("/settings#account");
  });

  it("會 canonicalize 路徑中的 .. 區段但仍停在同一個 origin", () => {
    expect(resolveSafeRedirect("/a/../settings")).toBe("/settings");
  });

  it("拒絕 protocol-relative（//host）並退回預設值", () => {
    expect(resolveSafeRedirect("//evil.com")).toBe("/settings");
    expect(resolveSafeRedirect("//evil.com/phish")).toBe("/settings");
  });

  it("拒絕反斜線變形的開放重導向（/\\\\evil.com 等同 //evil.com）", () => {
    expect(resolveSafeRedirect("/\\evil.com")).toBe("/settings");
    expect(resolveSafeRedirect("/\\/evil.com")).toBe("/settings");
    expect(resolveSafeRedirect("\\\\evil.com")).toBe("/settings");
  });

  it("拒絕字串中間出現反斜線，即使 origin 不會變", () => {
    expect(resolveSafeRedirect("/a\\b")).toBe("/settings");
  });

  it("拒絕帶 scheme 的絕對網址", () => {
    expect(resolveSafeRedirect("https://evil.com")).toBe("/settings");
    expect(resolveSafeRedirect("http://evil.com/settings")).toBe("/settings");
  });

  it("拒絕非 http(s) scheme", () => {
    expect(resolveSafeRedirect("javascript:alert(1)")).toBe("/settings");
    expect(resolveSafeRedirect("data:text/html,evil")).toBe("/settings");
  });

  it("拒絕沒有前導斜線的相對路徑", () => {
    expect(resolveSafeRedirect("settings")).toBe("/settings");
  });

  it("拒絕內含控制字元的值（含用換行夾帶 // 造成的變形開放重導向）", () => {
    expect(resolveSafeRedirect("/\n/evil.com")).toBe("/settings");
    expect(resolveSafeRedirect("/\t/evil.com")).toBe("/settings");
    expect(resolveSafeRedirect("/settings\r\nSet-Cookie: x=1")).toBe("/settings");
    expect(resolveSafeRedirect("/set\u0000tings")).toBe("/settings");
  });
});

describe("buildAuthCallbackUrl", () => {
  it("組出帶著已驗證 redirect 參數的 callback URL", () => {
    expect(buildAuthCallbackUrl("https://app.example.com", "/oauth/consent?authorization_id=abc")).toBe(
      "https://app.example.com/auth/callback?redirect=%2Foauth%2Fconsent%3Fauthorization_id%3Dabc"
    );
  });

  it("不安全的 redirect 目標會被換成預設值，不會把攻擊字串原樣塞進 callback URL", () => {
    const url = new URL(buildAuthCallbackUrl("https://app.example.com", "/\\evil.com"));
    expect(url.searchParams.get("redirect")).toBe("/settings");
  });
});
