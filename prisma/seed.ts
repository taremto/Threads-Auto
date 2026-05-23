import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

const PRISMA_DIR = __dirname;

const ENTRIES: { file: string; type: string; title: string; sortOrder: number }[] = [
  { file: "rules.md", type: "rules", title: "投稿生成ルール", sortOrder: 1 },
  { file: "structures.md", type: "structures", title: "投稿構成パターン集", sortOrder: 2 },
];

async function main() {
  for (const e of ENTRIES) {
    const filePath = path.join(PRISMA_DIR, e.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`SKIP: ${e.file} not found`);
      continue;
    }
    const content = fs.readFileSync(filePath, "utf-8");

    const existing = await prisma.knowledge.findFirst({
      where: { accountId: null, type: e.type, title: e.title },
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
          type: e.type,
          title: e.title,
          content,
          isDefault: true,
          sortOrder: e.sortOrder,
        },
      });
      console.log(`Created: ${e.title} (${content.length} chars)`);
    }
  }

  console.log("Seed completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
