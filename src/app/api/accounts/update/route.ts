import { prisma } from "@/lib/prisma";
import { ensureThreadsUserIdIsUnique } from "@/lib/account-identity";
import { normalizeAccountPostingHours } from "@/lib/account-posting";
import { tokenFingerprintOf } from "@/lib/gas-bridge";
import { fetchThreadsIdentity } from "@/lib/threads-identity";
import { NextResponse } from "next/server";

export async function PATCH(request: Request) {
  try {
    const { id, ...data } = await request.json();

    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    const updateData: Record<string, unknown> = {};
    if (typeof data.name === "string") updateData.name = data.name;
    if (typeof data.accessToken === "string") {
      const accessToken = data.accessToken.trim();
      if (accessToken) {
        const identity = await fetchThreadsIdentity(accessToken);
        if (!identity.ok) {
          return NextResponse.json({ error: identity.error }, { status: 400 });
        }
        const unique = await ensureThreadsUserIdIsUnique(
          id,
          identity.identity.userId
        );
        if (!unique.ok) {
          return NextResponse.json({ error: unique.error }, { status: 409 });
        }
        updateData.accessToken = accessToken;
        updateData.tokenFingerprint = tokenFingerprintOf(accessToken);
        updateData.threadsUserId = identity.identity.userId;
        if (identity.identity.username) {
          updateData.threadsUsername = identity.identity.username;
        }
      } else {
        updateData.accessToken = null;
        updateData.tokenFingerprint = null;
        updateData.tokenExpiresAt = null;
      }
    }
    if ("conceptSheet" in data) {
      updateData.conceptSheet =
        typeof data.conceptSheet === "string" ? data.conceptSheet : null;
    }
    if (typeof data.autoGenerate === "boolean") {
      updateData.autoGenerate = data.autoGenerate;
    }
    if (typeof data.scheduleJitterMinutes === "number") {
      updateData.scheduleJitterMinutes = Math.max(
        0,
        Math.min(59, Math.floor(data.scheduleJitterMinutes))
      );
    }
    if ("postingHours" in data) {
      const postingHours = normalizeAccountPostingHours(data.postingHours);
      updateData.postingHours = JSON.stringify(postingHours);
      updateData.postsPerDay = postingHours.length;
    } else if (typeof data.postsPerDay === "number") {
      updateData.postsPerDay = Math.max(1, Math.min(24, Math.floor(data.postsPerDay)));
    }

    const account = await prisma.account.update({ where: { id }, data: updateData });
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
