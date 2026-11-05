import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { installMockLocalStorage } from "../test/localStorageMock";
import { setAccountOwner } from "./accountStorage";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { createEmptyStore, writePersistedStore } from "./schema";
import { learningItemToRow } from "./sync/outbox";
import { createFakeSupabaseClient, FakeSupabaseDatabase } from "./sync/testSupabaseFake";
import { configureCloudSync, getRepository, markRepositoryAuthInitialized, waitForRepositoryInitialization, refreshCloudData, __resetRepositorySingletonForTests } from "./index";

it("shows a returning account's saved items before slow HTTP and shares overlapping refreshes", async () => {
  installMockLocalStorage(); __resetRepositorySingletonForTests(); setAccountOwner("A");
  const item = new LocalStorageLearningRepository().addItem({language:"ja",type:"vocabulary",promptZh:"狗",answer:"犬",source:"manual",tags:[]});
  setAccountOwner(null);
  const fake = createFakeSupabaseClient(new FakeSupabaseDatabase());
  fake.__db.table("learning_items").rows.push({ ...learningItemToRow(item, "A") });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const from = vi.fn((table: string) => {
    const query = fake.from(table), original = query.then.bind(query);
    query.then = ((ok: unknown, bad: unknown) => gate.then(() => original(ok as never, bad as never))) as typeof query.then;
    return query;
  });
  const client = { rpc: async () => ({ data: "0", error: null }), from } as unknown as SupabaseClient;
  configureCloudSync({ supabase: client, userId: "A" }); markRepositoryAuthInitialized();
  try {
    await waitForRepositoryInitialization();
    expect(getRepository().listItems().map(i => i.id)).toEqual([item.id]);
    await vi.waitFor(() => expect(from).toHaveBeenCalledTimes(6));
    refreshCloudData(); refreshCloudData(); configureCloudSync({ supabase: client, userId: "A" });
    expect(from).toHaveBeenCalledTimes(6);
  } finally {
    release();
    await vi.waitFor(() => expect(getRepository().listItems()).toHaveLength(1));
    configureCloudSync(null); __resetRepositorySingletonForTests();
  }
});

it("waits for the selected account's first complete download before planning", async () => {
  installMockLocalStorage(); __resetRepositorySingletonForTests(); setAccountOwner("A");
  const item=new LocalStorageLearningRepository().addItem({language:"ja",type:"vocabulary",promptZh:"狗",answer:"犬",source:"manual",tags:[]});
  writePersistedStore(createEmptyStore()); setAccountOwner(null);
  const database=new FakeSupabaseDatabase();
  database.tables.learning_items.rows.push(learningItemToRow(item,"A") as unknown as Record<string,unknown>);
  const fake=createFakeSupabaseClient(database);
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const client={rpc:async()=>({data:"0",error:null}),from(table:string){const query=fake.from(table);const original=query.then.bind(query);query.then=((ok:unknown,bad:unknown)=>gate.then(()=>original(ok as never,bad as never))) as typeof query.then;return query;}};
  let initialized=false;
  const waiting=waitForRepositoryInitialization().then(()=>{initialized=true;});
  configureCloudSync({supabase:client as unknown as SupabaseClient,userId:"A"});
  markRepositoryAuthInitialized();
  await Promise.resolve();
  expect(initialized).toBe(false);
  release(); await waiting;
  expect(getRepository().listItems().map(saved=>saved.id)).toEqual([item.id]);
  configureCloudSync(null); __resetRepositorySingletonForTests();
});
