"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "首頁" },
  { href: "/review", label: "複習" },
  { href: "/settings", label: "設定" },
] as const;

/**
 * 底部固定導覽列：把主要操作放在手機畫面下緣，符合單手操作的拇指熱區。
 */
export function BottomNav() { return <Suspense fallback={null}><BottomNavigation /></Suspense>; }
function BottomNavigation() {
  const pathname = usePathname();
  // Area practice and the word library are reached from the review hub, so they keep its tab lit.
  const section = ["/practice", "/progress", "/library"].some(prefix => pathname.startsWith(prefix)) ? "/review" : pathname;

  return (
    <nav
      aria-label="主要導覽"
      className="sticky bottom-0 z-10 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto flex w-[88%] max-w-xl items-stretch justify-between">
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === "/" ? section === "/" : section.startsWith(item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`relative flex min-h-14 items-center justify-center text-sm tracking-wide transition-colors ${
                  isActive ? "font-semibold text-foreground" : "text-foreground-muted hover:text-foreground"
                }`}
              >
                {isActive ? <span aria-hidden="true" className="absolute inset-x-[30%] top-0 h-0.5 bg-foreground" /> : null}
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
