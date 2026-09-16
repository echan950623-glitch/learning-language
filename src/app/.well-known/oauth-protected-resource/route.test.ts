import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "./route";

const ORIGINAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
});

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_URL;
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("回傳 resource（依請求推導的 host）與 authorization_servers（Supabase auth 端點）", async () => {
    const req = new Request("https://app.example.com/.well-known/oauth-protected-resource");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: "https://app.example.com/mcp",
      authorization_servers: ["https://project.supabase.co/auth/v1"],
    });
  });

  it("透過代理時使用 x-forwarded-* 推導出來的對外 host", async () => {
    const req = new Request("http://internal:3000/.well-known/oauth-protected-resource", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "learning-language.vercel.app" },
    });
    const res = await GET(req);

    expect((await res.json()).resource).toBe("https://learning-language.vercel.app/mcp");
  });

  it("缺少 NEXT_PUBLIC_SUPABASE_URL 環境變數時回傳 500，而不是拋出未捕捉的例外", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const req = new Request("https://app.example.com/.well-known/oauth-protected-resource");
    const res = await GET(req);

    expect(res.status).toBe(500);
  });
});
