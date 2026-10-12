import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEnglishPracticeCatalog } from "../src/domain/englishPracticeCatalog.ts";

const directory = join(process.cwd(), "output", "english-mcp-batches");
mkdirSync(directory, { recursive: true });
const catalog = getEnglishPracticeCatalog();
for(let start=0;start<catalog.length;start+=10) {
  const items = catalog.slice(start,start+10).map(({language,type,promptZh,answer,partOfSpeech,tags,englishPractice})=>({language,type,promptZh,answer,partOfSpeech,tags,englishPractice}));
  writeFileSync(join(directory,`batch-${start/10+1}.json`),JSON.stringify({items},null,2));
}
console.log(`Exported ${catalog.length} original senses / 150 questions in 3 preview batches. No confirm flag; no account data.`);
