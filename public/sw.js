// Service worker：離線 app shell + 同源靜態資源快取。
//
// 安全邊界（修改前務必確認新邏輯仍滿足以下條件，避免重新引入認證/憑證外洩風險）：
// - 絕不攔截跨來源請求，跨來源回應也絕不寫入快取。
// - 絕不攔截 /auth/*、/api/*、/oauth/*、/mcp：這些路徑可能回傳登入後的私有資料，
//   其中 /auth/callback 的 URL 上還帶著一次性的 OAuth code，攔截等同有機會把它寫進快取。
// - 非 GET 請求一律不攔截（沿用既有行為）。
// - 導覽（navigation）一律 network-first，只有離線時才退回快取的 app shell；
//   即使導覽成功，只要 URL 帶 code/token/error 這類 OAuth 參數，也絕不寫入快取。
// - 只快取白名單內的同源 app shell／靜態資源；回應帶 Cache-Control: private 或
//   no-store、或請求本身帶 Authorization 標頭，一律不快取（即使路徑在白名單內）。
// - 只在 activate 時刪除自己命名規則（CACHE_PREFIX）下的舊版本快取，不動其他快取，
//   也完全不碰 localStorage／IndexedDB（service worker 本來就無法直接存取這兩者）。
const CACHE_PREFIX = "learning-language-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v10`;
const APP_SHELL = ["/", "/manifest.webmanifest"];
const PRECACHE_ASSETS = ["/manifest.webmanifest"];

const BYPASS_EXACT_PATHS = ["/auth", "/api", "/oauth", "/mcp"];
const BYPASS_PATH_PREFIXES = ["/auth/", "/api/", "/oauth/", "/mcp/"];

const STATIC_ASSET_PATH_PATTERNS = [/^\/_next\/static\//, /^\/icons\//];

const OAUTH_QUERY_KEYS = [
  "code",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "token_hash",
  "state",
  "error",
  "error_description",
];

function isBypassedPath(pathname) {
  if (BYPASS_EXACT_PATHS.includes(pathname)) return true;
  return BYPASS_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isCacheableAssetPath(pathname) {
  if (APP_SHELL.includes(pathname)) return true;
  return STATIC_ASSET_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

function hasOAuthParams(url) {
  return OAUTH_QUERY_KEYS.some((key) => url.searchParams.has(key));
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isResponseCacheable(request, response) {
  if (!response || response.status !== 200) return false;
  if (response.redirected) return false;
  if (request.headers?.has("Authorization")) return false;
  const cacheControl = (response.headers.get("Cache-Control") || "").toLowerCase();
  if (cacheControl.includes("no-store") || cacheControl.includes("private")) return false;
  return true;
}

function isSafeFinalResponse(request, response) {
  if (!isResponseCacheable(request, response)) return false;
  const finalUrl = new URL(response.url || request.url || request, self.location.origin);
  return isSameOrigin(finalUrl) && !isBypassedPath(finalUrl.pathname) && !hasOAuthParams(finalUrl);
}

function logError(scope, error) {
  console.error(`【Service Worker】${scope}錯誤:`, {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
    timestamp: new Date().toISOString(),
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        for (const path of PRECACHE_ASSETS) {
          const response = await fetch(path);
          if (isSafeFinalResponse(path, response)) await cache.put(path, response.clone());
        }
      })
      .catch((error) => {
        // 首次安裝時若離線導致快取失敗，不阻擋 service worker 安裝
        logError("安裝預先快取", error);
      })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .catch((error) => {
        logError("清理舊版快取", error);
      })
  );
  self.clients.claim();
});

async function handleNavigation(request, url) {
  try {
    const response = await fetch(request);
    if (url.pathname === "/" && url.search === "" && isSafeFinalResponse(request, response)) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put("/", response.clone());
      } catch (cacheError) {
        logError("更新 app shell 快取", cacheError);
      }
    }
    return response;
  } catch {
    try {
      const cache = await caches.open(CACHE_NAME);
      const shell = await cache.match("/");
      if (shell) return shell;
    } catch (fallbackError) {
      logError("離線回退讀取 app shell 快取", fallbackError);
    }
    return new Response("目前離線，且尚未快取可用的頁面。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function handleAsset(request, event) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch (error) {
    logError("開啟資源快取", error);
    return fetch(request);
  }

  const cached = await cache.match(request).catch(() => undefined);
  const network = fetch(request)
    .then(async (response) => {
      if (isSafeFinalResponse(request, response)) {
        await cache.put(request, response.clone()).catch((error) => {
          logError("寫入資源快取", error);
        });
      }
      return response;
    })
    .catch((error) => {
      if (cached) return cached;
      throw error;
    });

  if (cached) event.waitUntil(network.then(() => undefined).catch(() => undefined));
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // 跨來源請求（包含 Google OAuth、Supabase 等）完全不攔截，交給瀏覽器預設行為。
  if (!isSameOrigin(url)) return;

  // 憑證型 query 或 Authorization request 完全不接觸共享快取（包含讀取）。
  if (hasOAuthParams(url) || request.headers.has("Authorization")) return;

  // 認證與 API 路徑完全不攔截：既避免快取到私有資料，也避免 /auth/callback
  // 這種 URL 上帶一次性 OAuth code 的導覽被寫進快取。
  if (isBypassedPath(url.pathname)) return;

  const isNavigation = request.mode === "navigate" || request.destination === "document";

  if (isNavigation) {
    event.respondWith(handleNavigation(request, url));
    return;
  }

  // 非導覽請求只在白名單（app shell／同源靜態資源）內才攔截與快取；
  // 其餘一律不攔截，避免意外快取到未預期的私有回應。
  if (isCacheableAssetPath(url.pathname)) {
    event.respondWith(handleAsset(request, event));
  }
});
