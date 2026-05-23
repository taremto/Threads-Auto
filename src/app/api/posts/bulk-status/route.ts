import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function PATCH(request: Request) {
  const { ids, status } = await request.json();

  if (!ids?.length || !status) {
    return NextResponse.json({ error: "ids and status required" }, { status: 400 });
  }

  const result = await prisma.post.updateMany({
    where: { id: { in: ids } },
    data: { status },
  });

  return NextResponse.json({ count: result.count });
}
