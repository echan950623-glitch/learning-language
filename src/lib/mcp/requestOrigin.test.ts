import { describe, expect, it } from "vitest";

import { getRequestOrigin } from "./requestOrigin";

describe("getRequestOrigin", () => {
  it("優先使用 x-forwarded-proto／x-forwarded-host（代理後面的真實對外位址）", () => {
    const req = new Request("http://internal:3000/mcp", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "example.vercel.app" },
    });
    expect(getRequestOrigin(req)).toBe("https://example.vercel.app");
  });

  it("沒有 x-forwarded-* 時退回 host header", () => {
    const req = new Request("http://internal:3000/mcp", { headers: { host: "localhost:3000" } });
    expect(getRequestOrigin(req)).toBe("http://localhost:3000");
  });

  it("完全沒有代理／host header 時退回 req.url 本身的 scheme／host", () => {
    const req = new Request("https://fallback.example.com/mcp");
    expect(getRequestOrigin(req)).toBe("https://fallback.example.com");
  });

  it("x-forwarded-* 有多個值（逗號分隔，最左邊是原始客戶端）時取第一個", () => {
    const req = new Request("http://internal:3000/mcp", {
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "outer.example.com, inner.example.com",
      },
    });
    expect(getRequestOrigin(req)).toBe("https://outer.example.com");
  });
});
