"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useHomeLanguage } from "@/lib/homeLanguage";

const NAV_ITEMS = [
  { href: "/", label: "首頁", icon: "🏠" },
  { href: "/progress", label: "進度", icon: "📊" },
  { href: "/settings", label: "設定", icon: "⚙️" },
] as const;

/**
 * 底部固定導覽列：把主要操作放在手機畫面下緣，符合單手操作的拇指熱區。
 */
export function BottomNav() { return <Suspense fallback={null}><BottomNavigation /></Suspense>; }
function BottomNavigation() {
  const pathname = usePathname();
  const homeLanguage = useHomeLanguage();
  const params = useSearchParams();
  const language = ["/study", "/progress"].includes(pathname) ? (params.get("language") === "en" ? "en" : "ja") : homeLanguage;

  return (
    <nav
      aria-label="主要導覽"
      className="sticky bottom-0 z-10 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex w-[94%] max-w-xl items-stretch justify-between">
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href === "/progress" && language === "en" ? "/progress?language=en" : item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-colors ${
                  isActive ? "text-primary" : "text-foreground-muted hover:text-foreground"
                }`}
              >
                <span aria-hidden="true" className="text-lg leading-none">
                  {item.icon}
                </span>
                {item.href === "/progress" && language === "en" ? "英文進度" : item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
