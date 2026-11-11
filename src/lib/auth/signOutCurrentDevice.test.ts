import { expect, it, vi } from "vitest";
import { signOutCurrentDevice } from "./signOutCurrentDevice";
it("signs out only this session", async () => {
  const signOut = vi.fn(async () => ({ error: null }));
  const getSession = vi.fn(async () => ({ data: { session: null }, error: null }));
  expect(await signOutCurrentDevice({ auth: { signOut, getSession } })).toBeNull();
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  expect(getSession).not.toHaveBeenCalled();
});
it.each([null, {}])("reports the actual local session after a remote failure: %j", async session => {
  const client = { auth: { signOut: async () => ({ error: new Error("offline") }), getSession: async () => ({ data: { session }, error: null }) } };
  expect(await signOutCurrentDevice(client)).toBe(session ? "登出失敗，請稍後再試。" : "此裝置已登出，但伺服器尚未確認。");
});
