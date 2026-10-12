"use client";

import { useEffect } from "react";

/** 掛載一次，在瀏覽器支援時註冊 service worker；失敗只記警告，不影響其他功能。 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[learning-language] Service worker 註冊失敗", error);
    });
    // Next client navigation needs RSC responses. Offline use the cached static page
    // through a document navigation instead, preserving its URL and IndexedDB state.
    const navigateOffline = (event: MouseEvent) => {
      if (navigator.onLine || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor || anchor.download || (anchor.target && anchor.target !== "_self")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || !["/", "/study", "/review", "/progress", "/settings", "/practice"].includes(url.pathname)) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      window.location.assign(url.href);
    };
    document.addEventListener("click", navigateOffline, true);
    return () => document.removeEventListener("click", navigateOffline, true);
  }, []);

  return null;
}
