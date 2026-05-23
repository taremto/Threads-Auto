import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function PATCH(request: Request) {
  try {
    const { id, ...data } = await request.json();

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    const account = await prisma.account.update({ where: { id }, data });
    return NextResponse.json(account);
  } catch (e) {
    console.error("accounts/update error:", e);
    return NextResponse.json(
      {
        error:
          "アカウント設定の保存に失敗しました: " +
          (e instanceof Error ? e.message : String(e)),
      },
      { status: 500 }
    );
  }
}
