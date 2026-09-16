import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { BottomNav } from "@/components/BottomNav";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { DurabilityBanner } from "@/components/DurabilityBanner";
import { AuthSyncBootstrapper } from "@/components/AuthSyncBootstrapper";
import { SyncStatusBanner } from "@/components/SyncStatusBanner";

export const metadata: Metadata = {
  title: "AI 語言學習教練（日文優先原型）",
  description: "日文優先的主動回想學習與複習排程原型。資料只存在本機瀏覽器，尚未串接 AI／登入／雲端。",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#3d3aa8",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-TW" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <ServiceWorkerRegister />
        <AuthSyncBootstrapper />
        <DurabilityBanner />
        <SyncStatusBanner />
        <div className="flex min-h-full flex-1 flex-col">{children}</div>
        <BottomNav />
      </body>
    </html>
  );
}
