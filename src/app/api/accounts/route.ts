import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const accounts = await prisma.account.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { posts: true } },
    },
  });
  return NextResponse.json(accounts);
}

export async function POST(request: Request) {
  const body = await request.json();
  const account = await prisma.account.create({
    data: {
      name: body.name,
      threadsUserId: body.threadsUserId || null,
      threadsUsername: body.threadsUsername || null,
      accessToken: body.accessToken || null,
    },
  });
  return NextResponse.json(account, { status: 201 });
}
