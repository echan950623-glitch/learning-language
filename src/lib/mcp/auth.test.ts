import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: getUserMock } })),
}));

import { authenticateMcpRequest } from "./auth";

const ORIGINAL_ENV = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

beforeEach(() => {
  getUserMock.mockReset();
  vi.mocked(createClient).mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "public-key";
});

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_ENV.url;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ORIGINAL_ENV.key;
});

describe("authenticateMcpRequest", () => {
  it("缺少 Authorization header 時回傳 401，且 WWW-Authenticate 指向這台主機的 well-known", async () => {
    const req = new Request("https://app.example.com/mcp", { method: "POST" });
    const result = await authenticateMcpRequest(req);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource"'
    );
    // 沒有 token 就不該去呼叫 Supabase。
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("Authorization header 不是 Bearer 格式時回傳 401", async () => {
    const req = new Request("https://app.example.com/mcp", { headers: { Authorization: "Basic xyz" } });
    const result = await authenticateMcpRequest(req);

    expect(result.ok).toBe(false);
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("token 驗證失敗（getUser 回傳 error）時回傳 401，不建立 scoped client", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: "invalid token" } });
    const req = new Request("https://app.example.com/mcp", { headers: { Authorization: "Bearer bad-token" } });

    const result = await authenticateMcpRequest(req);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(401);
    // 只會呼叫一次 createClient（驗證用），不會再建立第二個 scoped client。
    expect(vi.mocked(createClient)).toHaveBeenCalledTimes(1);
  });

  it("getUser 拋出例外時回傳 401，不會讓例外往外炸", async () => {
    getUserMock.mockRejectedValue(new Error("network down"));
    const req = new Request("https://app.example.com/mcp", { headers: { Authorization: "Bearer token" } });

    const result = await authenticateMcpRequest(req);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(401);
  });

  it("token 驗證成功時回傳 userId／accessToken，並用該 token 建立第二個 scoped client", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user_123" } }, error: null });
    const req = new Request("https://app.example.com/mcp", { headers: { Authorization: "Bearer good-token" } });

    const result = await authenticateMcpRequest(req);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.context.userId).toBe("user_123");
    expect(result.context.accessToken).toBe("good-token");

    // 第一次呼叫是驗證用的 client；第二次呼叫必須帶著使用者的 access token（RLS 依據）。
    const calls = vi.mocked(createClient).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][2]).toMatchObject({ global: { headers: { Authorization: "Bearer good-token" } } });
    // 絕對不能用 secret/service-role key 建立這裡的任何 client——這裡沒有任何一次呼叫
    // 使用 publishable key 以外的字串，本測試用固定的 "public-key" 佐證這一點。
    expect(calls[0][1]).toBe("public-key");
    expect(calls[1][1]).toBe("public-key");
  });

  it("缺少環境變數時回傳 500，而不是丟出未捕捉的例外", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const req = new Request("https://app.example.com/mcp", { headers: { Authorization: "Bearer token" } });

    const result = await authenticateMcpRequest(req);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.response.status).toBe(500);
  });
});
