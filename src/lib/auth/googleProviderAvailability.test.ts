import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isGoogleOAuthProviderAvailable } from "./googleProviderAvailability";

const ORIGINAL_ENV = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "public-key";
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_ENV.url;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ORIGINAL_ENV.key;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isGoogleOAuthProviderAvailable", () => {
  it("external.google 為 true 且回應 200 時回傳 true", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ external: { google: true, apple: false } }));

    await expect(isGoogleOAuthProviderAvailable()).resolves.toBe(true);
  });

  it("用 no-store、只帶 publishable key 的 apikey header 查詢固定的 /auth/v1/settings 路徑", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ external: { google: true } }));

    await isGoogleOAuthProviderAvailable();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(requestUrl)).toBe("https://project.supabase.co/auth/v1/settings");
    expect(init).toMatchObject({ cache: "no-store", headers: { apikey: "public-key" } });
    // 不能用 Authorization header 帶任何 secret/service-role 之類的東西。
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("external.google 為 false 時回傳 false（尚未啟用）", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ external: { google: false } }));

    await expect(isGoogleOAuthProviderAvailable()).resolves.toBe(false);
  });

  it("external 缺漏或格式不符時 fail closed 回傳 false", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}));
    await expect(isGoogleOAuthProviderAvailable()).resolves.toBe(false);

    vi.mocked(fetch).mockResolvedValue(jsonResponse({ external: null }));
    await expect(isGoogleOAuthProviderAvailable()).resolves.toBe(false);
  });

  it("回應非 200 時 fail closed 回傳 false", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ external: { google: true } }, false, 500));

    await expect(isGoogleOAuthProviderAvailable()).resolves.toBe(false);
  });

  it("fetch 拋出網路例外時 fail closed 回傳 false，不會讓例外往外炸", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    await expect(isGoogleOAuthProviderAvailable()).resolves.toBe(false);
  });

  it("回應 JSON 格式不合法時 fail closed 回傳 false", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json");
      },
    } as unknown as Response);

    await expect(isGoogleOAuthProviderAvailable()).resolves.toBe(false);
  });

  it("缺少 Supabase 環境變數時 fail closed 回傳 false，且不會呼叫 fetch", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    await expect(isGoogleOAuthProviderAvailable()).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
