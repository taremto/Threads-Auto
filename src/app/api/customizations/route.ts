import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const CUSTOMIZATIONS_KEY = "customizations";

export type CustomizationEntry = {
  id: string;
  name: string;
  description: string;
  checkFile?: string; // このファイルパスが存在しなければ未適用（src/ 以下の相対パス）
  addedAt: string;
};

/**
 * GET /api/customizations
 * 登録済みカスタマイズ一覧を返す + 各項目の適用状態をファイル存在チェックで判定
 */
export async function GET() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: CUSTOMIZATIONS_KEY },
  });

  if (!setting) {
    return NextResponse.json({ items: [], needsReapply: false });
  }

  let items: CustomizationEntry[];
  try {
    items = JSON.parse(setting.value);
  } catch {
    items = [];
  }

  // ファイル存在チェック（ネットワーク不要 = 高速）
  const srcRoot = path.join(process.cwd(), "src");
  const results = items.map((item) => {
    let applied = true;
    if (item.checkFile) {
      applied = fs.existsSync(path.join(srcRoot, item.checkFile));
    }
    return { ...item, applied };
  });

  const needsReapply = results.some((r) => !r.applied);

  return NextResponse.json({ items: results, needsReapply });
}

/**
 * POST /api/customizations
 * カスタマイズを登録（追加）する
 */
export async function POST(request: Request) {
  const newEntry: Omit<CustomizationEntry, "addedAt"> = await request.json();

  const setting = await prisma.appSetting.findUnique({
    where: { key: CUSTOMIZATIONS_KEY },
  });

  let items: CustomizationEntry[] = [];
  if (setting) {
    try {
      items = JSON.parse(setting.value);
    } catch {
      items = [];
    }
  }

  const existing = items.findIndex((i) => i.id === newEntry.id);
  const entry: CustomizationEntry = {
    ...newEntry,
    addedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    items[existing] = entry;
  } else {
    items.push(entry);
  }

  await prisma.appSetting.upsert({
    where: { key: CUSTOMIZATIONS_KEY },
    update: { value: JSON.stringify(items) },
    create: { key: CUSTOMIZATIONS_KEY, value: JSON.stringify(items) },
  });

  return NextResponse.json({ ok: true });
}
