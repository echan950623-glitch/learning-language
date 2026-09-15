import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 使用者家目錄下有一個不相關的 package-lock.json，會讓 Turbopack 誤判 workspace root
  // 往上跑到 C:\Users\echan；明確指定專案目錄本身，避免掃到不相關檔案。
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
