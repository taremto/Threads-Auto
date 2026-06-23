import { prisma } from "@/lib/prisma";
import { ensureThreadsUserIdIsUnique } from "@/lib/account-identity";
import { tokenFingerprintOf } from "@/lib/gas-bridge";
import { fetchThreadsIdentity } from "@/lib/threads-identity";
import { NextResponse } from "next/server";

function databaseErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const isDatabaseSetupError =
    message.includes("DATABASE_URL") ||
    message.includes("Unable to open the database file") ||
    message.includes("does not exist in the current database") ||
    message.includes("no such table") ||
    message.includes("Error querying the database");

  if (!isDatabaseSetupError) {
    return null;
  }

  return NextResponse.json(
    {
      error:
        "保存用データベースの準備がまだ完了していません。いったん黒い起動画面を閉じて、setup.command（Windowsの方は setup.bat）をもう一度開いてください。アップデート後に出た場合は、update.command（Windowsの方は update.bat）をもう一度実行してください。",
      detail: "database_not_ready",
    },
    { status: 503 }
  );
}

export async function GET() {
  try {
    const accounts = await prisma.account.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { posts: true } },
      },
    });
    return NextResponse.json(accounts);
  } catch (error) {
    const setupError = databaseErrorResponse(error);
    if (setupError) return setupError;
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accessToken =
      typeof body.accessToken === "string" && body.accessToken.trim()
        ? body.accessToken.trim()
        : null;
    let threadsUserId =
      typeof body.threadsUserId === "string" && body.threadsUserId.trim()
        ? body.threadsUserId.trim()
        : null;
    let threadsUsername =
      typeof body.threadsUsername === "string" && body.threadsUsername.trim()
        ? body.threadsUsername.trim()
        : null;

    if (accessToken) {
      const identity = await fetchThreadsIdentity(accessToken);
      if (!identity.ok) {
        return NextResponse.json({ error: identity.error }, { status: 400 });
      }
      if (threadsUserId && threadsUserId !== identity.identity.userId) {
        return NextResponse.json(
          {
            error:
              `入力されたThreadsユーザーID(${threadsUserId})と、` +
              `アクセストークンのThreadsユーザーID(${identity.identity.userId})が一致しません。`,
          },
          { status: 409 }
        );
      }
      const unique = await ensureThreadsUserIdIsUnique(
        "__new_account__",
        identity.identity.userId
      );
      if (!unique.ok) {
        return NextResponse.json({ error: unique.error }, { status: 409 });
      }
      threadsUserId = identity.identity.userId;
      threadsUsername = identity.identity.username || threadsUsername;
    } else if (threadsUserId) {
      const unique = await ensureThreadsUserIdIsUnique(
        "__new_account__",
        threadsUserId
      );
      if (!unique.ok) {
        return NextResponse.json({ error: unique.error }, { status: 409 });
      }
    }

    const account = await prisma.account.create({
      data: {
        name: body.name,
        threadsUserId,
        threadsUsername,
        accessToken,
        tokenFingerprint: tokenFingerprintOf(accessToken),
      },
    });
    return NextResponse.json(account, { status: 201 });
  } catch (error) {
    const setupError = databaseErrorResponse(error);
    if (setupError) return setupError;
    throw error;
  }
}
