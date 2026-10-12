"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { EnglishPracticePicker } from "@/components/EnglishPracticePicker";
import { ENGLISH_PRACTICE_CATEGORIES } from "@/domain/englishPracticeSelection";

function EnglishPracticeContent() {
  const category = useSearchParams().get("category");
  const selected = ENGLISH_PRACTICE_CATEGORIES.find(c => c.id === category)?.id ?? "vocabulary";
  return <EnglishPracticePicker key={selected} initialCategory={selected} />;
}

export default function EnglishPracticePage() {
  return <Suspense fallback={<main className="mx-auto w-[94%] max-w-xl py-6 text-foreground-muted">載入英文練習…</main>}><EnglishPracticeContent /></Suspense>;
}
