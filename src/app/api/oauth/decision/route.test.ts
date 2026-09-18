import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  approveAuthorization: vi.fn(),
  denyAuthorization: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: {
    getUser: mocks.getUser,
    oauth: { approveAuthorization: mocks.approveAuthorization, denyAuthorization: mocks.denyAuthorization },
  } }),
}));
import { POST } from "./route";

function request(decision: string) {
  return new Request("https://learning-language-three.vercel.app/api/oauth/decision", {
    method: "POST", body: new URLSearchParams({ authorization_id: "test-authorization", decision }),
  });
}
describe("OAuth decision redirects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "test-user" } } });
    const result = { data: { redirect_url: "https://chatgpt.com/connector/oauth/test" }, error: null };
    mocks.approveAuthorization.mockResolvedValue(result);
    mocks.denyAuthorization.mockResolvedValue(result);
  });
  it.each(["approve", "deny"])("%s redirects with GET semantics", async (decision) => {
    const response = await POST(request(decision));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://chatgpt.com/connector/oauth/test");
  });
  it("redirects expired login with GET semantics", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const response = await POST(request("approve"));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/auth/sign-in");
    expect(mocks.approveAuthorization).not.toHaveBeenCalled();
  });
  it("rejects invalid decisions without authorizing", async () => {
    expect((await POST(request("invalid"))).status).toBe(400);
    expect(mocks.approveAuthorization).not.toHaveBeenCalled();
    expect(mocks.denyAuthorization).not.toHaveBeenCalled();
  });
});
