import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// ナレッジ一覧取得
// - scope=all: 共通＋全アカウント分の全件（管理画面用）
// - accountId=<id>: そのアカウント固有＋共通のマージ（生成時用）
// - 未指定: 共通のみ
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("accountId");
  const scope = searchParams.get("scope");

  let where: object;
  if (scope === "all") {
    where = {};
  } else if (accountId) {
    where = { OR: [{ accountId }, { accountId: null }] };
  } else {
    where = { accountId: null };
  }

  const knowledges = await prisma.knowledge.findMany({
    where,
    orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
  });

  return NextResponse.json(knowledges);
}

// ナレッジ作成
export async function POST(request: Request) {
  try {
    const { accountId, type, title, content, isDefault } = await request.json();

    if (!title || !content) {
      return NextResponse.json(
        { error: "タイトルと内容を入力してください。" },
        { status: 400 }
      );
    }

    const maxSort = await prisma.knowledge.aggregate({
      where: { accountId: accountId || null },
      _max: { sortOrder: true },
    });

    const knowledge = await prisma.knowledge.create({
      data: {
        accountId: accountId || null,
        type: type || "custom",
        title,
        content,
        isDefault: isDefault || false,
        sortOrder: (maxSort._max.sortOrder ?? 0) + 1,
      },
    });

    return NextResponse.json(knowledge, { status: 201 });
  } catch (e) {
    console.error("knowledge POST error:", e);
    return NextResponse.json(
      { error: "ナレッジの作成に失敗しました: " + (e instanceof Error ? e.message : String(e)) },
      { status: 500 }
    );
  }
}

// ナレッジ更新
export async function PATCH(request: Request) {
  try {
    const { id, ...data } = await request.json();

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    const knowledge = await prisma.knowledge.update({
      where: { id },
      data,
    });

    return NextResponse.json(knowledge);
  } catch (e) {
    console.error("knowledge PATCH error:", e);
    return NextResponse.json(
      { error: "ナレッジの保存に失敗しました: " + (e instanceof Error ? e.message : String(e)) },
      { status: 500 }
    );
  }
}

// ナレッジ削除
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    await prisma.knowledge.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("knowledge DELETE error:", e);
    return NextResponse.json(
      { error: "ナレッジの削除に失敗しました: " + (e instanceof Error ? e.message : String(e)) },
      { status: 500 }
    );
  }
}
