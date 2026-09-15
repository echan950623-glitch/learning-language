"use client";

import { useEffect, useState } from "react";
import { getRepository } from "@/repository";

/**
 * R4：localStorage 在啟動時不可用而退回 MemoryLearningRepository 時，
 * UI 必須明確警告「這次分頁關掉或重新整理資料會遺失」，不能只寫 console。
 */
export function DurabilityBanner() {
  const [isVolatile, setIsVolatile] = useState(false);

  useEffect(() => {
    setIsVolatile(getRepository().durability === "volatile");
  }, []);

  if (!isVolatile) return null;

  return (
    <div role="alert" className="bg-danger-bg px-4 py-2 text-center text-xs font-medium text-danger">
      ⚠️ 這個瀏覽器目前無法使用本機儲存，學習紀錄只會保留在這次分頁開啟期間，重新整理或關閉分頁就會遺失。
    </div>
  );
}
