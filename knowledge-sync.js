#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * knowledge-sync.js
 * knowledge/ フォルダのmdファイルをDBに同期するスクリプト
 *
 * 使い方:
 *   node knowledge-sync.js           -- 差分を表示して確認（dry-run）
 *   node knowledge-sync.js --apply   -- 実際にDBに書き込む
 */

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
const DRY_RUN = !process.argv.includes('--apply');

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const meta = {};
  match[1].split('\n').forEach(line => {
    const [key, ...rest] = line.split(': ');
    if (key) meta[key.trim()] = rest.join(': ').trim();
  });
  return { meta, content: match[2].trimStart() };
}

async function main() {
  const prisma = new PrismaClient();

  try {
    const mdFiles = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md') && entry.name !== 'README.md') mdFiles.push(full);
      }
    }
    walk(KNOWLEDGE_DIR);

    let updated = 0, skipped = 0;

    for (const filePath of mdFiles) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        console.log(`[SKIP] フロントマターなし: ${path.relative(KNOWLEDGE_DIR, filePath)}`);
        skipped++;
        continue;
      }

      const { meta, content } = parsed;
      if (!meta.id) {
        console.log(`[SKIP] id なし: ${path.relative(KNOWLEDGE_DIR, filePath)}`);
        skipped++;
        continue;
      }

      const dbRow = await prisma.knowledge.findUnique({ where: { id: meta.id } });
      if (!dbRow) {
        console.log(`[SKIP] DB に id が見つからない: ${meta.id} (${meta.title})`);
        skipped++;
        continue;
      }

      if (dbRow.content === content && dbRow.title === meta.title) {
        skipped++;
        continue;
      }

      console.log(`[UPDATE] ${meta.title}`);
      if (dbRow.title !== meta.title) console.log(`  title: "${dbRow.title}" → "${meta.title}"`);
      if (dbRow.content !== content) console.log(`  content: ${dbRow.content.length}文字 → ${content.length}文字`);

      if (!DRY_RUN) {
        await prisma.knowledge.update({
          where: { id: meta.id },
          data: { title: meta.title, content },
        });
      }
      updated++;
    }

    console.log('');
    if (DRY_RUN) {
      console.log(`[dry-run] 更新対象: ${updated}件, スキップ: ${skipped}件`);
      if (updated > 0) console.log('実際に反映するには: node knowledge-sync.js --apply');
    } else {
      console.log(`完了: 更新 ${updated}件, スキップ: ${skipped}件`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
