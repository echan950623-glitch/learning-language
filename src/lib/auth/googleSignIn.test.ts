import { describe, expect, it, vi } from "vitest";

import { startGoogleSignIn, type GoogleSignInClient } from "./googleSignIn";

function makeClient(signInWithOAuth: GoogleSignInClient["auth"]["signInWithOAuth"]): GoogleSignInClient {
  return { auth: { signInWithOAuth } };
}

describe("startGoogleSignIn", () => {
  it("固定用 provider google、prompt select_account，且不帶任何 scopes", async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({
      data: { provider: "google", url: "https://accounts.google.com/o/oauth2/auth", flowId: "flow-1" },
      error: null,
    });

    const result = await startGoogleSignIn(
      makeClient(signInWithOAuth),
      "https://app.example.com/auth/callback?redirect=%2Fsettings"
    );

    expect(result.error).toBeNull();
    expect(signInWithOAuth).toHaveBeenCalledTimes(1);

    const [args] = signInWithOAuth.mock.calls[0] as [{ provider: string; options: Record<string, unknown> }];
    expect(args.provider).toBe("google");
    expect(args.options.redirectTo).toBe("https://app.example.com/auth/callback?redirect=%2Fsettings");
    expect(args.options.queryParams).toEqual({ prompt: "select_account" });
    // 不能額外要求任何敏感 scopes。
    expect(args.options).not.toHaveProperty("scopes");
  });

  it("SDK 回傳 error 時回傳固定的友善訊息，不會把內部錯誤文字外洩給使用者", async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({
      data: { provider: "google", url: null, flowId: null },
      error: { name: "AuthApiError", message: "provider is not enabled", status: 400, code: "provider_disabled" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await startGoogleSignIn(makeClient(signInWithOAuth), "https://app.example.com/auth/callback");

    expect(result.error).toBe("無法啟動 Google 登入，請稍後再試，或改用下方 Email 登入連結。");
    expect(result.error).not.toContain("provider is not enabled");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("呼叫時丟出例外也不會往外炸，回傳一樣的友善訊息", async () => {
    const signInWithOAuth = vi.fn().mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await startGoogleSignIn(makeClient(signInWithOAuth), "https://app.example.com/auth/callback");

    expect(result.error).toBe("無法啟動 Google 登入，請稍後再試，或改用下方 Email 登入連結。");
  });
});
