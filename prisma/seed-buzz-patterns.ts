import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

const ENTRIES: { file: string; title: string; sortOrder: number }[] = [
  {
    file: "buzz-hook-patterns.md",
    title: "バズフックパターン集（実バズ247件抽出）",
    sortOrder: 10,
  },
  {
    file: "market-hook-patterns-generic.md",
    title: "市場フックパターン集（25型）",
    sortOrder: 11,
  },
  {
    file: "posting-system-generic.md",
    title: "Threadsツリー投稿生成 汎用フレームワーク",
    sortOrder: 12,
  },
  {
    file: "biz-niche-playbook.md",
    title: "稼ぐ系・実用系ジャンル特化プレイブック",
    sortOrder: 13,
  },
];

async function main() {
  for (const e of ENTRIES) {
    const filePath = path.join(__dirname, e.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`SKIP: ${e.file} not found`);
      continue;
    }
    const content = fs.readFileSync(filePath, "utf-8");

    const existing = await prisma.knowledge.findFirst({
      where: { accountId: null, type: "custom", title: e.title },
    });

    if (existing) {
      await prisma.knowledge.update({
        where: { id: existing.id },
        data: { content, sortOrder: e.sortOrder },
      });
      console.log(`Updated: ${e.title} (${content.length} chars)`);
    } else {
      await prisma.knowledge.create({
        data: {
          accountId: null,
          type: "custom",
          title: e.title,
          content,
          isDefault: true,
          sortOrder: e.sortOrder,
        },
      });
      console.log(`Created: ${e.title} (${content.length} chars)`);
    }
  }

  console.log("\n--- 現在の共通ナレッジ ---");
  const all = await prisma.knowledge.findMany({
    where: { accountId: null },
    orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
    select: { type: true, title: true, content: true },
  });
  for (const k of all) {
    console.log(`[${k.type}] ${k.title}: ${k.content.length} chars`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
