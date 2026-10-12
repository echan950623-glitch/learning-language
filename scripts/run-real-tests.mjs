import { spawnSync } from "node:child_process";
if (process.env.RUN_REAL_TESTS !== "1") {
  console.error("Real tests create temporary cloud users. Authorization and RUN_REAL_TESTS=1 are required.");
  process.exit(1);
}
const files = process.argv[2] === "rls" ? ["src/lib/supabase/rls.test.ts"] : ["src/lib/supabase/rls.test.ts", "src/lib/mcp/tools/realDb.integration.test.ts", "src/repository/sync/scheduleRebase.real.test.ts", "src/repository/sync/missingCloudSession.real.test.ts", "src/repository/sync/learningEvents.real.test.ts"];
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...files], { stdio: "inherit", env: { ...process.env, RUN_REAL_SCHEDULE_REBASE_TEST: "1", RUN_REAL_MISSING_SESSION_TEST: "1" } });
process.exit(result.status ?? 1);
