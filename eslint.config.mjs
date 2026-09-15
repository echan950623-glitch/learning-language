import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // 這個 App 的資料只存在瀏覽器 localStorage（見 repository 層），沒有伺服器資料來源，
      // 也刻意不在 render 期間直接讀取，以避免 SSR/CSR 的 hydration mismatch（見 CLAUDE.md 的
      // 「不要覆寫既有架構決策」精神，實際決策記在 ARCHITECTURE.md）。
      // 頁面掛載後用 useEffect 讀一次 repository 屬於「同步外部系統狀態」的合法情境，
      // 不是這條規則要抓的「用 effect 算衍生狀態」反模式。
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
