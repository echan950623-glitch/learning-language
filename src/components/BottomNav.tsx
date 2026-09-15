"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "首頁", icon: "🏠" },
  { href: "/study", label: "今日學習", icon: "📖" },
  { href: "/add", label: "新增", icon: "➕" },
  { href: "/progress", label: "進度", icon: "📊" },
] as const;

/**
 * 底部固定導覽列：把主要操作放在手機畫面下緣，符合單手操作的拇指熱區。
 */
export function BottomNav() {
  const pathname = usePathname();

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
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-colors ${
                  isActive ? "text-primary" : "text-foreground-muted hover:text-foreground"
                }`}
              >
                <span aria-hidden="true" className="text-lg leading-none">
                  {item.icon}
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
