/**
 * 從收到的請求推導對外可見的 origin（scheme + host），用於：
 * - `.well-known/oauth-protected-resource` 回傳的 `resource` 欄位。
 * - 401 回應 `WWW-Authenticate` header 裡的 `resource_metadata` URL。
 *
 * 不能寫死網域：同一份程式碼會跑在本機開發（http://localhost:3000）與 Vercel 正式環境，
 * 而 Vercel／大部分平台都是透過代理轉發，實際對外的 scheme／host 要看
 * `x-forwarded-proto`／`x-forwarded-host`，不能只看 `req.url`（那通常是內部位址）。
 */
export function getRequestOrigin(req: Request): string {
  const url = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const forwardedHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");

  const protocol = forwardedProto?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = forwardedHost?.split(",")[0]?.trim() || url.host;

  return `${protocol}://${host}`;
}
