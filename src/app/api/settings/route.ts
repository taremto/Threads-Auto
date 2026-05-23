import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// アプリ設定取得
export async function GET() {
  const settings = await prisma.appSetting.findMany();
  const map: Record<string, string> = {};
  for (const s of settings) {
    map[s.key] = s.value;
  }
  return NextResponse.json(map);
}

// アプリ設定更新（upsert）
export async function POST(request: Request) {
  const entries: Record<string, string> = await request.json();

  for (const [key, value] of Object.entries(entries)) {
    await prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  return NextResponse.json({ ok: true });
}
