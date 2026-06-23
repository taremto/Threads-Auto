import { prisma } from "@/lib/prisma";
import { syncOneAccount } from "@/lib/gas-sync";
import { NextRequest, NextResponse } from "next/server";
import type { Post } from "@prisma/client";

const CLOUD_SYNC_MIN_INTERVAL_MS = 30_000;

async function refreshCloudResultsBeforeList(accountId: string, status: string | null) {
  if (status !== "queued" && status !== "posted") return;

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      cloudOffloadEnabled: true,
      gasWebAppUrl: true,
      lastSyncedAt: true,
    },
  });

  if (!account?.cloudOffloadEnabled || !account.gasWebAppUrl) return;

  const lastSyncedAt = account.lastSyncedAt?.getTime() ?? 0;
  if (Date.now() - lastSyncedAt < CLOUD_SYNC_MIN_INTERVAL_MS) return;

  try {
    await syncOneAccount(accountId);
  } catch (e) {
    console.warn("[GET /api/posts] cloud sync skipped:", e);
  }
}

function sortPostedPostsForDisplay(posts: Post[]): Post[] {
  const groups = new Map<number, Post[]>();
  for (const post of posts) {
    const group = groups.get(post.groupNo) || [];
    group.push(post);
    groups.set(post.groupNo, group);
  }

  return Array.from(groups.values())
    .map((group) => {
      const sorted = [...group].sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
      const groupPostedAt = Math.max(
        ...sorted.map((p) => p.postedAt?.getTime() ?? 0)
      );
      return { groupPostedAt, posts: sorted };
    })
    .sort((a, b) => b.groupPostedAt - a.groupPostedAt)
    .flatMap((group) => group.posts);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const accountId = searchParams.get("accountId");
    const status = searchParams.get("status");

    if (!accountId) {
      return NextResponse.json({ error: "accountId required" }, { status: 400 });
    }

    // 一覧をブロックしない。GAS同期は裏で走らせ、取込結果は次のポーリング(15秒)で反映。
    // 鮮度は instrumentation.ts の5分おき syncAllCloudAccounts でも担保される。
    void refreshCloudResultsBeforeList(accountId, status).catch((e) =>
      console.warn("[GET /api/posts] background cloud sync error:", e)
    );

    const orderBy =
      status === "queued"
        ? [{ publishAt: "asc" as const }, { sortOrder: "asc" as const }]
        : status === "posted"
          ? [{ postedAt: "desc" as const }]
          : // draft/error: groupNo を第一キーにして、sortOrder が衝突してもツリーを必ず連続表示にする
            [
              { groupNo: "asc" as const },
              { sortOrder: "asc" as const },
              { createdAt: "asc" as const },
            ];

    const posts = await prisma.post.findMany({
      where: {
        accountId,
        ...(status ? { status } : {}),
      },
      orderBy,
      include: {
        media: { orderBy: { sortOrder: "asc" } },
      },
    });
    return NextResponse.json(
      status === "posted" ? sortPostedPostsForDisplay(posts) : posts
    );
  } catch (e) {
    console.error("GET /api/posts error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = await request.json();

  if (Array.isArray(body)) {
    const posts = await prisma.post.createMany({ data: body });
    return NextResponse.json({ count: posts.count }, { status: 201 });
  }

  const post = await prisma.post.create({ data: body });
  return NextResponse.json(post, { status: 201 });
}

export async function PATCH(request: Request) {
  const body = await request.json();
  const { id, ...data } = body;

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const post = await prisma.post.update({ where: { id }, data });
  return NextResponse.json(post);
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  await prisma.post.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
