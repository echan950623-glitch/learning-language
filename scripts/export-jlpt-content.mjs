import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";

// Content files only; no database client, credentials, account IDs or network writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ configFile: false, root, server: { middlewareMode: true }, appType: "custom" });
try {
  const { getJlptPracticeCatalog, buildJlptPreviewBatches, JLPT_SOURCES } = await server.ssrLoadModule("/src/domain/jlptPracticeCatalog.ts");
  const output = path.join(root, "output", "jlpt-content");
  await mkdir(output, { recursive: true });
  const catalog = getJlptPracticeCatalog();
  const summary = { sources: JLPT_SOURCES, original: true, target: "N4", n5LearnedConfirmed: true, n4LearnedConfirmed: false, levels: {} };
  for (const level of ["N5", "N4"]) {
    const entries = catalog.filter(e => e.practice.conceptKey.startsWith(`jlpt:${level.toLowerCase()}:`));
    const batches = buildJlptPreviewBatches(level, level === "N5");
    const files = [];
    for (const [index, batch] of batches.entries()) {
      const name = `${level.toLowerCase()}-preview-${index + 1}.json`;
      await writeFile(path.join(output, name), JSON.stringify(batch, null, 2) + "\n", "utf8");
      files.push(name);
    }
    summary.levels[level] = { concepts: entries.length, questions: entries.reduce((n, e) => n + e.practice.variants.length, 0), files };
  }
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(summary.levels));
} finally {
  await server.close();
}
