import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { exchangeCodeForSession: mocks.exchangeCodeForSession },
  }),
}));

import { GET } from "./route";

function request(path: string): NextRequest {
  return new NextRequest(`https://app.example.com${path}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("auth callback", () => {
  it("成功交換 code 後導回已驗證的 redirect 目標", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(request("/auth/callback?code=good-code&redirect=%2Foauth%2Fconsent%3Fauthorization_id%3Dabc"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://app.example.com/oauth/consent?authorization_id=abc");
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("good-code");
  });

  it("沒有 redirect 參數時預設導回 /settings", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(request("/auth/callback?code=good-code"));

    expect(response.headers.get("location")).toBe("https://app.example.com/settings");
  });

  it("redirect 參數是開放重導向攻擊字串時，退回預設值而不是導去外部網站", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(request("/auth/callback?code=good-code&redirect=%2F%5Cevil.com"));

    const location = response.headers.get("location")!;
    expect(new URL(location).host).toBe("app.example.com");
    expect(location).toBe("https://app.example.com/settings");
  });

  it("provider 回傳 error（使用者拒絕授權）時導回登入頁並帶固定代碼，保留原始 redirect", async () => {
    const response = await GET(
      request("/auth/callback?error=access_denied&error_description=User+denied&redirect=%2Fsettings")
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.get("error")).toBe("oauth_denied");
    expect(location.searchParams.get("redirect")).toBe("/settings");
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("缺少 code 時導回登入頁並帶固定代碼", async () => {
    const response = await GET(request("/auth/callback?redirect=%2Fsettings"));

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.get("error")).toBe("oauth_missing_code");
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("交換 session 失敗時導回登入頁並帶固定代碼，不外洩內部錯誤文字，也不記錄原始 code", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({
      error: { message: "invalid grant: secret-single-use-code", code: "bad_code_verifier" },
    });
    const errorSpy = vi.spyOn(console, "error");

    const response = await GET(request("/auth/callback?code=secret-single-use-code&redirect=%2Fsettings"));

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.get("error")).toBe("oauth_exchange_failed");

    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("secret-single-use-code");
    }
  });

  it("任意 provider 錯誤參數不會寫入日誌或轉址", async () => {
    const response = await GET(request("/auth/callback?error=secret-provider-value"));
    expect(response.headers.get("location")).not.toContain("secret-provider-value");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret-provider-value");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("exchangeCodeForSession 拋出例外時也導回登入頁並帶固定代碼，不會讓例外往外炸", async () => {
    mocks.exchangeCodeForSession.mockRejectedValue(new Error("network down"));

    const response = await GET(request("/auth/callback?code=good-code&redirect=%2Fsettings"));

    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.get("error")).toBe("oauth_exchange_failed");
  });
});
