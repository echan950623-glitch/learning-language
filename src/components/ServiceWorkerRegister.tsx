"use client";

import { useEffect } from "react";

/** 掛載一次，在瀏覽器支援時註冊 service worker；失敗只記警告，不影響其他功能。 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[learning-language] Service worker 註冊失敗", error);
    });
  }, []);

  return null;
}
