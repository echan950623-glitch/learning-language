interface SignOutClient {
  auth: {
    signOut(options: { scope: "local" }): Promise<{ error: unknown }>;
    getSession(): Promise<{ data: { session: unknown | null }; error: unknown }>;
  };
}
/** Keep other sessions and all account-owned learning snapshots intact. */
export async function signOutCurrentDevice(client: SignOutClient): Promise<string | null> {
  try {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (!error) return null;
    const { data, error: sessionError } = await client.auth.getSession();
    if (sessionError) return "無法確認登出狀態，請重新開啟 App。";
    return data.session ? "登出失敗，請稍後再試。" : "此裝置已登出，但伺服器尚未確認。";
  } catch { return "無法確認登出狀態，請重新開啟 App。"; }
}
