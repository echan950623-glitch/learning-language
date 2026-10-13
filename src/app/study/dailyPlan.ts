import type { SupabaseClient } from "@supabase/supabase-js";
import type { DailyPlan, Language } from "@/domain/types";
import { createDailyPlan, learningDay } from "@/domain/learningRules";
import { getRepository, mutateRepository } from "@/repository";
import { getAccountGeneration, getAccountOwner, isSyncPaused } from "@/repository/accountStorage";
import { isDailyPlan } from "@/repository/schema";
import { createBrowserClient } from "@/lib/supabase/client";
import { drainOutboxFully } from "@/repository/sync/syncEngine";
import { loadAliasStore, resolveCanonicalItemId, resolveLocalItemIdForCanonical, translatePlan } from "@/repository/sync/alias";
import { readBusyMode, readDailyNewItemCap, saveDailyNewItemCap } from "@/lib/studyPreferences";
import { createDailyAreaPlan, type DailyStudyArea } from "@/domain/dailyStudyAreas";

/** Network reservation precedes a local session; never hold a browser data lock while waiting for HTTP. */
export async function prepareDailyPlan(now = new Date(), language: Language = "ja", area?: DailyStudyArea): Promise<DailyPlan> {
  const owner = getAccountOwner();
  const generation = getAccountGeneration();
  const current = () => owner === getAccountOwner() && generation === getAccountGeneration();
  // The cloud reservation also checks the saved account preference. Save and drain it before requesting 50 words.
  if (area === "new" && readDailyNewItemCap() !== 50) {
    await mutateRepository(() => {
      if (!current()) throw new Error("帳戶已切換，新字額度未更新。");
      saveDailyNewItemCap(50);
    });
  }
  const cap = area ? 50 : readDailyNewItemCap();
  const busy = area ? false : readBusyMode();
  let previouslyReserved: DailyPlan | undefined;
  // Planning shares the same durable account snapshot as explicitly added content.
  let plan = await mutateRepository(repository => {
    if (!current()) throw new Error("帳戶已切換，今日計畫未寫入。");
    const existing = repository.listDailyPlans().find(saved => saved.date === learningDay(now) && saved.language === language);
    previouslyReserved = existing;
    const items = repository.listItems({ language }), schedules = repository.listScheduleStates({ language }), attempts = repository.listReviewAttempts({ language });
    return repository.saveDailyPlan(area ? createDailyAreaPlan(items, schedules, now, existing, attempts, language) : createDailyPlan(items, schedules, now, cap, busy, existing, undefined, attempts, language));
  });
  const existing = previouslyReserved;
  if (owner && navigator.onLine && !isSyncPaused()) {
    const client: SupabaseClient = createBrowserClient();
    const drained = await drainOutboxFully(client, undefined, owner);
    if (!current()) throw new Error("帳戶已切換，今日計畫未寫入。");
    if (drained.success) {
      const aliases = loadAliasStore(owner);
      const requested = translatePlan(plan, id => resolveCanonicalItemId(aliases, id));
      const result = await client.rpc("reserve_daily_plan", { payload: requested });
      if (!current()) throw new Error("帳戶已切換，舊計畫未寫入。");
      if (!result.error && isDailyPlan(result.data)) {
        const reserved = translatePlan(result.data, id => resolveLocalItemIdForCanonical(aliases, id) ?? id);
        plan = { ...plan, reservationOwner: owner, newItemIds: reserved.newItemIds,
          completedUnitKeys: [...new Set([...plan.completedUnitKeys, ...reserved.completedUnitKeys])] };
      } else if (existing?.reservationOwner !== owner) {
        plan = { ...plan, newItemIds: [], reason: "今天的新字額度尚未取得，先完成已保存的複習；連線後可再試。" };
      } else plan = { ...plan, reservationOwner: owner, newItemIds: existing.newItemIds };
    } else if (existing?.reservationOwner !== owner) {
      plan = { ...plan, newItemIds: [], reason: "待同步紀錄尚未送完，先做既有複習；新字額度稍後取得。" };
    } else plan = { ...plan, reservationOwner: owner, newItemIds: existing.newItemIds };
  } else if (owner) {
    if (existing?.reservationOwner === owner) plan = { ...plan, reservationOwner: owner, newItemIds: existing.newItemIds };
    else plan = { ...plan, newItemIds: [], reason: "离線時先做既有複習；連線後取得今天的新字額度。" };
  }
  const repository = getRepository();
  const items = new Map(repository.listItems({ language }).map(item => [item.id, item]));
  const enrolled = new Set(repository.listScheduleStates({ language }).map(schedule => schedule.learningItemId));
  plan.units = plan.units.filter(unit => {
    const item = items.get(unit.learningItemId);
    return item && (!busy || unit.kind === "review") && (item.introducedAt || enrolled.has(item.id) || (area && item.practice?.learned) || (cap > 0 && plan.newItemIds.includes(item.id)));
  });
  if (!current()) throw new Error("帳戶已切換，今日計畫未寫入。");
  return mutateRepository(fresh => {
    if (!current()) throw new Error("帳戶已切換，今日計畫未寫入。");
    // The repository saves unreserved review plans locally without enqueuing an invalid reservation.
    return fresh.saveDailyPlan(plan);
  });
}
