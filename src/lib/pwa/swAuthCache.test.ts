// public/sw.js 是純 service worker 全域腳本（用 self.addEventListener 註冊事件），
// 不是 ES module，無法直接 import。這裡用 node:vm 把原始碼跑在一個獨立的假
// worker 全域（self / caches / fetch / location...）裡，直接觸發 install / activate /
// fetch 事件監聽器並觀察行為，藉此驗證真正會上線的那份程式碼，而不是重寫一份等價邏輯。
import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const SW_URL = new URL("../../../public/sw.js", import.meta.url);
const SW_SOURCE = readFileSync(SW_URL, "utf-8");

const ORIGIN = "https://learning-language.example";

type FetchImpl = (input: unknown) => Promise<Response>;

type FakeCache = {
  match: (input: unknown) => Promise<Response | undefined>;
  put: (input: unknown, response: Response) => Promise<void>;
  addAll: (urls: string[]) => Promise<void>;
};

type FakeCacheStorage = {
  open: (name: string) => Promise<FakeCache>;
  keys: () => Promise<string[]>;
  delete: (name: string) => Promise<boolean>;
  match: (input: unknown) => Promise<Response | undefined>;
  buckets: Map<string, Map<string, Response>>;
};

function keyOf(input: unknown): string {
  return typeof input === "string" ? input : (input as { url: string }).url;
}

function createFakeCacheStorage(fetchImpl: FetchImpl): FakeCacheStorage {
  const buckets = new Map<string, Map<string, Response>>();

  function bucketFor(name: string): Map<string, Response> {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = new Map();
      buckets.set(name, bucket);
    }
    return bucket;
  }

  return {
    open: async (name: string) => {
      const bucket = bucketFor(name);
      return {
        match: async (input: unknown) => bucket.get(keyOf(input)),
        put: async (input: unknown, response: Response) => {
          bucket.set(keyOf(input), response);
        },
        addAll: async (urls: string[]) => {
          for (const url of urls) {
            const response = await fetchImpl(url);
            bucket.set(url, response.clone());
          }
        },
      };
    },
    keys: async () => Array.from(buckets.keys()),
    delete: async (name: string) => buckets.delete(name),
    match: async (input: unknown) => {
      const key = keyOf(input);
      for (const bucket of buckets.values()) {
        if (bucket.has(key)) return bucket.get(key);
      }
      return undefined;
    },
    buckets,
  };
}

async function findCachedEntry(caches: FakeCacheStorage, key: string): Promise<Response | undefined> {
  for (const bucket of caches.buckets.values()) {
    if (bucket.has(key)) return bucket.get(key);
  }
  return undefined;
}

function ok(body = "ok", headers?: HeadersInit): Response {
  return new Response(body, { status: 200, headers });
}

function okAt(url: string, body = "ok", redirected = false): Response {
  const response = ok(body);
  Object.defineProperty(response, "url", { value: url });
  Object.defineProperty(response, "redirected", { value: redirected });
  return response;
}

function makeRequest(overrides: {
  url: string;
  method?: string;
  mode?: string;
  destination?: string;
  headers?: Headers;
}) {
  return {
    url: overrides.url,
    method: overrides.method ?? "GET",
    mode: overrides.mode ?? "same-origin",
    destination: overrides.destination ?? "",
    headers: overrides.headers ?? new Headers(),
  };
}

type FakeEvent = {
  request?: ReturnType<typeof makeRequest>;
  respondWithPromise: Promise<Response> | undefined;
  waitUntilPromise: Promise<unknown> | undefined;
  respondWith: (value: Response | Promise<Response>) => void;
  waitUntil: (value: Promise<unknown>) => void;
};

function makeEvent(request?: ReturnType<typeof makeRequest>): FakeEvent {
  const event: FakeEvent = {
    request,
    respondWithPromise: undefined,
    waitUntilPromise: undefined,
    respondWith(value) {
      event.respondWithPromise = Promise.resolve(value);
    },
    waitUntil(value) {
      event.waitUntilPromise = Promise.resolve(value);
    },
  };
  return event;
}

function createSandbox(fetchImpl: FetchImpl) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const caches = createFakeCacheStorage(fetchImpl);

  const sandbox: Record<string, unknown> = {
    console,
    URL,
    Response,
    location: { origin: ORIGIN },
    caches,
    fetch: fetchImpl,
    skipWaitingCalled: false,
    clientsClaimed: false,
    addEventListener(type: string, handler: (event: unknown) => void) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    skipWaiting() {
      sandbox.skipWaitingCalled = true;
    },
    clients: {
      claim() {
        sandbox.clientsClaimed = true;
      },
    },
  };
  sandbox.self = sandbox;

  const context = createContext(sandbox);
  runInContext(SW_SOURCE, context, { filename: "public/sw.js" });

  function dispatch(type: string, event: unknown) {
    for (const handler of listeners.get(type) ?? []) handler(event);
  }

  return { dispatch, caches, sandbox };
}

describe("sw.js／跨來源與敏感路徑：完全不攔截", () => {
  it("跨來源請求（例如 Google OAuth）不攔截，也不會進入任何快取", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok("cross-origin body"));
    const { dispatch, caches } = createSandbox(fetchMock);
    const event = makeEvent(
      makeRequest({ url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc" })
    );

    dispatch("fetch", event);

    expect(event.respondWithPromise).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await caches.keys()).toEqual([]);
  });

  it("/auth/callback?code=... 不攔截，一次性 OAuth code 不會被寫入快取", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok("<html>callback</html>"));
    const { dispatch, caches } = createSandbox(fetchMock);
    const event = makeEvent(
      makeRequest({
        url: `${ORIGIN}/auth/callback?code=super-secret-oauth-code&state=xyz`,
        mode: "navigate",
        destination: "document",
      })
    );

    dispatch("fetch", event);

    expect(event.respondWithPromise).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await caches.keys()).toEqual([]);
  });

  it.each(["/api/progress", "/oauth/consent", "/mcp", "/auth/sign-in"])(
    "同源敏感路徑 %s 不攔截",
    async (pathname) => {
      const fetchMock = vi.fn<FetchImpl>(async () => ok());
      const { dispatch } = createSandbox(fetchMock);
      const event = makeEvent(makeRequest({ url: `${ORIGIN}${pathname}` }));

      dispatch("fetch", event);

      expect(event.respondWithPromise).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("非 GET 請求不攔截", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok());
    const { dispatch } = createSandbox(fetchMock);
    const event = makeEvent(makeRequest({ url: `${ORIGIN}/study`, method: "POST" }));

    dispatch("fetch", event);

    expect(event.respondWithPromise).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sw.js／導覽：network-first 與離線回退", () => {
  it("導覽 \"/\" 成功時回傳網路回應，並更新 app shell 快取", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok("<html>shell v2</html>"));
    const { dispatch, caches } = createSandbox(fetchMock);
    const event = makeEvent(
      makeRequest({ url: `${ORIGIN}/`, mode: "navigate", destination: "document" })
    );

    dispatch("fetch", event);
    expect(event.respondWithPromise).toBeDefined();
    const response = await event.respondWithPromise!;

    expect(await response.text()).toBe("<html>shell v2</html>");
    const cached = await findCachedEntry(caches, "/");
    expect(cached).toBeDefined();
    expect(await cached!.clone().text()).toBe("<html>shell v2</html>");
  });

  it.each(["/?code=abc123", "/?token=abc123", "/?error=access_denied&error_description=denied"])(
    "導覽 %s 完全交給瀏覽器，不讀寫 service worker 快取",
    async (search) => {
      const fetchMock = vi.fn<FetchImpl>(async () => ok("<html>poisoned</html>"));
      const { dispatch, caches } = createSandbox(fetchMock);
      const event = makeEvent(
        makeRequest({ url: `${ORIGIN}${search}`, mode: "navigate", destination: "document" })
      );

      dispatch("fetch", event);
      expect(event.respondWithPromise).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await findCachedEntry(caches, "/")).toBeUndefined();
    }
  );

  it("導覽到 /progress 成功時不寫入快取（只有 \"/\" 是明確的 app shell）", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok("<html>progress</html>"));
    const { dispatch, caches } = createSandbox(fetchMock);
    const url = `${ORIGIN}/progress`;
    const event = makeEvent(makeRequest({ url, mode: "navigate", destination: "document" }));

    dispatch("fetch", event);
    await event.respondWithPromise;

    expect(await findCachedEntry(caches, "/progress")).toBeUndefined();
    expect(await findCachedEntry(caches, url)).toBeUndefined();
  });

  it.each([
    ["跨來源", "https://accounts.google.com/o/oauth2/auth"],
    ["同源登入頁", `${ORIGIN}/auth/sign-in?next=%2Fsettings`],
  ])("導覽 / 的最終回應若 redirect 到%s，不得寫入 app shell", async (_label, finalUrl) => {
    const fetchMock = vi.fn<FetchImpl>(async () => okAt(finalUrl, "redirected login", true));
    const { dispatch, caches } = createSandbox(fetchMock);
    const event = makeEvent(makeRequest({ url: `${ORIGIN}/`, mode: "navigate", destination: "document" }));
    dispatch("fetch", event);
    await event.respondWithPromise;
    expect(await findCachedEntry(caches, "/")).toBeUndefined();
  });

  it("離線導覽時退回已快取的 app shell（保留離線可用的學習外殼）", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => {
      throw new TypeError("network unreachable");
    });
    const { dispatch, caches } = createSandbox(fetchMock);
    const shellCache = await caches.open("learning-language-shell-v14");
    await shellCache.put("/", ok("<html>cached shell</html>"));

    const event = makeEvent(
      makeRequest({ url: `${ORIGIN}/study`, mode: "navigate", destination: "document" })
    );
    dispatch("fetch", event);
    const response = await event.respondWithPromise!;

    expect(await response.text()).toBe("<html>cached shell</html>");
  });

  it("離線且尚未快取任何內容時，回傳保底離線回應而不丟出例外", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => {
      throw new TypeError("network unreachable");
    });
    const { dispatch } = createSandbox(fetchMock);
    const event = makeEvent(
      makeRequest({ url: `${ORIGIN}/`, mode: "navigate", destination: "document" })
    );

    dispatch("fetch", event);
    const response = await event.respondWithPromise!;

    expect(response.status).toBe(503);
  });
});

describe("sw.js／同源靜態資源：白名單快取", () => {
  it.each([
    ["/manifest.webmanifest", "manifest"],
    ["/icons/icon.svg", "image"],
    ["/_next/static/chunks/app.abc123.js", "script"],
  ])("白名單資源 %s 會被攔截並快取", async (pathname, destination) => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok("asset body"));
    const { dispatch, caches } = createSandbox(fetchMock);
    const url = `${ORIGIN}${pathname}`;
    const event = makeEvent(makeRequest({ url, destination }));

    dispatch("fetch", event);
    expect(event.respondWithPromise).toBeDefined();
    await event.respondWithPromise;

    expect(await findCachedEntry(caches, url)).toBeDefined();
  });

  it("不在白名單內的同源資源不攔截，預設不快取", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok());
    const { dispatch } = createSandbox(fetchMock);
    const event = makeEvent(makeRequest({ url: `${ORIGIN}/some-unlisted-file.json` }));

    dispatch("fetch", event);

    expect(event.respondWithPromise).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("回應帶 Cache-Control: private 時不寫入快取，即使路徑在白名單內", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () =>
      ok("private body", { "Cache-Control": "private, max-age=0" })
    );
    const { dispatch, caches } = createSandbox(fetchMock);
    const url = `${ORIGIN}/icons/icon.svg`;
    const event = makeEvent(makeRequest({ url, destination: "image" }));

    dispatch("fetch", event);
    await event.respondWithPromise;

    expect(await findCachedEntry(caches, url)).toBeUndefined();
  });

  it("回應帶 Cache-Control: no-store 時不寫入快取", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok("body", { "Cache-Control": "no-store" }));
    const { dispatch, caches } = createSandbox(fetchMock);
    const url = `${ORIGIN}/manifest.webmanifest`;
    const event = makeEvent(makeRequest({ url }));

    dispatch("fetch", event);
    await event.respondWithPromise;

    expect(await findCachedEntry(caches, url)).toBeUndefined();
  });

  it("請求本身帶 Authorization 標頭時不讀取也不寫入共享快取", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok("body"));
    const { dispatch, caches } = createSandbox(fetchMock);
    const url = `${ORIGIN}/manifest.webmanifest`;
    const headers = new Headers({ Authorization: "Bearer secret-token" });
    await (await caches.open("learning-language-shell-v14")).put(url, ok("shared cached body"));
    const event = makeEvent(makeRequest({ url, headers }));

    dispatch("fetch", event);
    expect(event.respondWithPromise).toBeUndefined();
    expect(await (await findCachedEntry(caches, url))!.text()).toBe("shared cached body");
  });

  it.each(["access_token=secret", "token_hash=secret", "state=secret"])(
    "靜態資源帶敏感參數 %s 時完全不接觸快取",
    async (search) => {
      const fetchMock = vi.fn<FetchImpl>(async () => ok("sensitive"));
      const { dispatch, caches } = createSandbox(fetchMock);
      const url = `${ORIGIN}/manifest.webmanifest?${search}`;
      const event = makeEvent(makeRequest({ url }));
      dispatch("fetch", event);
      expect(event.respondWithPromise).toBeUndefined();
      expect(await findCachedEntry(caches, url)).toBeUndefined();
    }
  );

  it("資源離線時退回先前快取的版本", async () => {
    const url = `${ORIGIN}/icons/icon.svg`;
    const fetchMock = vi.fn<FetchImpl>(async () => {
      throw new TypeError("network unreachable");
    });
    const { dispatch, caches } = createSandbox(fetchMock);
    const cache = await caches.open("learning-language-shell-v14");
    await cache.put(url, ok("cached icon"));

    const event = makeEvent(makeRequest({ url, destination: "image" }));
    dispatch("fetch", event);
    const response = await event.respondWithPromise!;

    expect(await response.text()).toBe("cached icon");
    expect(event.waitUntilPromise).toBeDefined();
  });
});

describe("sw.js／activate：只清自己命名規則下的舊版本快取", () => {
  it("刪除同一 app 的舊版本快取，保留當前版本與不相干的其他快取", async () => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok());
    const { dispatch, caches, sandbox } = createSandbox(fetchMock);

    await (await caches.open("learning-language-shell-v12")).put("/", ok("old"));
    await (await caches.open("learning-language-shell-v14")).put("/", ok("current"));
    await (await caches.open("some-unrelated-app-cache")).put("/x", ok("unrelated"));

    const event = makeEvent();
    dispatch("activate", event);
    await event.waitUntilPromise;

    const remaining = await caches.keys();
    expect(remaining).toContain("learning-language-shell-v14");
    expect(remaining).toContain("some-unrelated-app-cache");
    expect(remaining).not.toContain("learning-language-shell-v12");
    expect(sandbox.clientsClaimed).toBe(true);
  });
});

describe("sw.js／install：只預先快取可公開的靜態檔", () => {
  it("預先快取 manifest 到 v14，不在 install 階段快取可能帶 session 的 /", async () => {
    const fetchMock = vi.fn<FetchImpl>(async (input) => ok(`body:${keyOf(input)}`));
    const { dispatch, caches, sandbox } = createSandbox(fetchMock);

    const event = makeEvent();
    dispatch("install", event);
    await event.waitUntilPromise;

    expect(await caches.keys()).toContain("learning-language-shell-v14");
    expect(await findCachedEntry(caches, "/")).toBeUndefined();
    expect(await findCachedEntry(caches, "/manifest.webmanifest")).toBeDefined();
    expect(sandbox.skipWaitingCalled).toBe(true);
  });

  it.each(["private, max-age=0", "no-store"])("manifest 回應為 Cache-Control: %s 時不預快取", async (cacheControl) => {
    const fetchMock = vi.fn<FetchImpl>(async () => ok("manifest", { "Cache-Control": cacheControl }));
    const { dispatch, caches } = createSandbox(fetchMock);
    const event = makeEvent();
    dispatch("install", event);
    await event.waitUntilPromise;
    expect(await findCachedEntry(caches, "/manifest.webmanifest")).toBeUndefined();
  });
});
