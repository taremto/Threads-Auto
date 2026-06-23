import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

type DefaultKnowledge = {
  file: string;
  type: string;
  title: string;
  sortOrder: number;
};

const PRISMA_DIR = __dirname;

const DEFAULT_KNOWLEDGE: DefaultKnowledge[] = [
  { file: "rules.md", type: "rules", title: "投稿生成ルール", sortOrder: 1 },
  { file: "structures.md", type: "structures", title: "投稿構成パターン集", sortOrder: 2 },
  {
    file: "buzz-hook-patterns.md",
    type: "custom",
    title: "バズフックパターン集（実バズ247件抽出）",
    sortOrder: 10,
  },
  {
    file: "market-hook-patterns-generic.md",
    type: "custom",
    title: "市場フックパターン集（25型）",
    sortOrder: 11,
  },
  {
    file: "posting-system-generic.md",
    type: "custom",
    title: "Threadsツリー投稿生成 汎用フレームワーク",
    sortOrder: 12,
  },
  {
    file: "biz-niche-playbook.md",
    type: "custom",
    title: "稼ぐ系・実用系ジャンル特化プレイブック",
    sortOrder: 13,
  },
];

async function main() {
  let createdCount = 0;
  let existingCount = 0;

  for (const entry of DEFAULT_KNOWLEDGE) {
    const existing = await prisma.knowledge.findFirst({
      where: {
        accountId: null,
        type: entry.type,
        title: entry.title,
      },
      select: { id: true },
    });

    if (existing) {
      existingCount += 1;
      continue;
    }

    const filePath = path.join(PRISMA_DIR, entry.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`SKIP: ${entry.file} not found`);
      continue;
    }

    await prisma.knowledge.create({
      data: {
        accountId: null,
        type: entry.type,
        title: entry.title,
        content: fs.readFileSync(filePath, "utf-8"),
        isDefault: true,
        sortOrder: entry.sortOrder,
      },
    });
    createdCount += 1;
  }

  if (createdCount > 0) {
    console.log(`既定ナレッジを追加しました: ${createdCount}件`);
  } else {
    console.log(`既定ナレッジは投入済みです: ${existingCount}件`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
