#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * knowledge-apply-raito.js
 * らいとリポのナレッジをWebアプリDBへ統合適用する（1回限りの移行スクリプト）。
 *   node knowledge-apply-raito.js          -- dry-run（差分表示のみ）
 *   node knowledge-apply-raito.js --apply  -- 実際にDBへ反映
 * 事前に prisma/dev.db のバックアップを取っていること。
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const ACCT = 'cmoz8pe6i0000w8s8rwz7w0j8'; // らいと
const BASE = path.join(__dirname, 'knowledge', 'カスタム-raito_tenshoku');

function readBody(rel) {
  const raw = fs.readFileSync(path.join(BASE, rel), 'utf8');
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (m ? m[1] : raw).trimStart();
}

// 既存行の本文を置換（idで特定）
const UPDATES = [
  { id: 'cmpqz4x5r0001w8tkd64mjwoi', title: 'らいと投稿生成ルール（統合）', file: '_統合DB登録/らいと投稿生成ルール（統合）.md' },
  { id: 'cmpwn9s8o0001w8gc7v7h6yhh', file: '03_案件別CTA/UZUZ｜ThreadsCTA用ナレッジ.md' },
  { id: 'cmpwnanx10003w8gc1h4hcini', file: '03_案件別CTA/ポジウィルキャリア｜ThreadsCTA用ナレッジ.md' },
];
// 無効化（idで特定）
const DISABLES = [
  { id: 'cmq3mulmw0001w844nrus8wwb', why: 'コアルール（要点は統合rulesへ。rules枠は1件しか使われないため無効化）' },
];
// 新規作成（accountId+title が既存ならスキップ）
const INSERTS = [
  { type: 'structures', enabled: true,  sortOrder: 6, title: 'らいと投稿構成パターン集（37種）', file: '_統合DB登録/らいと投稿構成パターン集（37種）.md' },
  { type: 'custom', enabled: true,  title: '弁護士法人ガイア法律事務所_ThreadsCTA用ナレッジ', file: '03_案件別CTA/弁護士法人ガイア法律事務所_ThreadsCTA用ナレッジ.md' },
  { type: 'custom', enabled: true,  title: '現行運用パラメータ', file: '04_運用・データ/現行運用パラメータ.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 00 ナレッジの使い方・優先順位', file: '07_専門ナレッジ/00 ナレッジの使い方・優先順位.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 01 限界サイン・メンタルヘルス', file: '07_専門ナレッジ/01 限界サイン・メンタルヘルス.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 02 職場リスク・ハラスメント', file: '07_専門ナレッジ/02 職場リスク・ハラスメント.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 03 労働条件・相談先', file: '07_専門ナレッジ/03 労働条件・相談先.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 04 自己理解・キャリア軸', file: '07_専門ナレッジ/04 自己理解・キャリア軸.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 05 職業理解・求人票・企業研究', file: '07_専門ナレッジ/05 職業理解・求人票・企業研究.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 05A 求人票の裏側・ブラック求人の読み方', file: '07_専門ナレッジ/05A 求人票の裏側・ブラック求人の読み方.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 06 面接・退職理由', file: '07_専門ナレッジ/06 面接・退職理由.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 07 案件接続ルール', file: '07_専門ナレッジ/07 案件接続ルール.md' },
  { type: 'custom', enabled: false, title: '専門ナレッジ 99 参考ソース一覧', file: '07_専門ナレッジ/99 参考ソース一覧.md' },
  { type: 'custom', enabled: false, title: 'Threads×高単価アフィリエイト 運用指南書', file: '04_運用・データ/Threads×高単価アフィリエイト 運用指南書.md' },
  { type: 'custom', enabled: false, title: '悩み素材バンク', file: '04_運用・データ/悩み素材バンク.md' },
  { type: 'custom', enabled: false, title: '発信者体験談ナレッジ（アフィ投稿before素材）', file: '04_運用・データ/発信者体験談ナレッジ（アフィ投稿before素材）.md' },
  { type: 'custom', enabled: false, title: '1行目フック100選→らいと最適化 変換ナレッジ', file: '01_パターン集/1行目フック100選→らいと最適化 変換ナレッジ.md' },
  { type: 'custom', enabled: false, title: 'らいと フォロー誘導CTAパターン集', file: '01_パターン集/らいと フォロー誘導CTAパターン集.md' },
  { type: 'custom', enabled: false, title: '【テンプレ】ThreadsCTA用ナレッジ', file: '01_パターン集/【テンプレ】ThreadsCTA用ナレッジ.md' },
  { type: 'custom', enabled: false, title: 'らいと｜ペルソナ設計_27歳一般事務_美咲', file: '02_アカウント設計/らいと｜ペルソナ設計_27歳一般事務_美咲.md' },
];

(async () => {
  const p = new PrismaClient();
  let nU = 0, nD = 0, nI = 0, nSkip = 0;
  console.log(`\n=== ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);

  console.log('--- UPDATE（既存行の本文置換） ---');
  for (const u of UPDATES) {
    const row = await prismaFind(p, u.id);
    if (!row) { console.log(`  [MISS] id=${u.id} が無い`); continue; }
    const body = readBody(u.file);
    const newTitle = u.title || row.title;
    console.log(`  [UPDATE] ${row.title}${u.title && u.title !== row.title ? ` → ${u.title}` : ''}  (${row.content.length}字 → ${body.length}字)`);
    if (APPLY) await p.knowledge.update({ where: { id: u.id }, data: { title: newTitle, content: body } });
    nU++;
  }

  console.log('\n--- DISABLE（enabled=false） ---');
  for (const d of DISABLES) {
    const row = await prismaFind(p, d.id);
    if (!row) { console.log(`  [MISS] id=${d.id} が無い`); continue; }
    console.log(`  [DISABLE] ${row.title}  (現enabled=${row.enabled})  ※${d.why}`);
    if (APPLY) await p.knowledge.update({ where: { id: d.id }, data: { enabled: false } });
    nD++;
  }

  console.log('\n--- INSERT（新規。title重複はスキップ） ---');
  let maxSort = (await p.knowledge.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0;
  for (const ins of INSERTS) {
    const exists = await p.knowledge.findFirst({ where: { accountId: ACCT, title: ins.title } });
    if (exists) { console.log(`  [SKIP] 既存: ${ins.title}`); nSkip++; continue; }
    const body = readBody(ins.file);
    const so = ins.sortOrder != null ? ins.sortOrder : (++maxSort);
    console.log(`  [INSERT] (${ins.type}/en=${ins.enabled ? 'T' : 'F'}/so=${so}) ${ins.title}  (${body.length}字)`);
    if (APPLY) await p.knowledge.create({ data: { accountId: ACCT, type: ins.type, title: ins.title, content: body, enabled: ins.enabled, sortOrder: so } });
    nI++;
  }

  console.log(`\n=== 合計: UPDATE ${nU} / DISABLE ${nD} / INSERT ${nI} / SKIP ${nSkip} ===`);
  if (!APPLY) console.log('反映するには: node knowledge-apply-raito.js --apply');
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });

async function prismaFind(p, id) { return p.knowledge.findUnique({ where: { id } }); }
