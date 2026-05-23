import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const accountId = searchParams.get("accountId");
    const status = searchParams.get("status");

    if (!accountId) {
      return NextResponse.json({ error: "accountId required" }, { status: 400 });
    }

    const orderBy =
      status === "queued"
        ? [{ publishAt: "asc" as const }, { sortOrder: "asc" as const }]
        : status === "posted"
          ? [{ postedAt: "desc" as const }, { sortOrder: "asc" as const }]
          : [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

    const posts = await prisma.post.findMany({
      where: {
        accountId,
        ...(status ? { status } : {}),
      },
      orderBy,
    });
    return NextResponse.json(posts);
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
