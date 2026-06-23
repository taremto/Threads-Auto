/**
 * 毎朝5時の自動生成処理
 * autoGenerate=true のアカウントに対して投稿を自動生成する
 * Claude Code CLI使用（サブスク範囲内）
 */

import { PrismaClient } from "@prisma/client";
import { dailyPostCountFromPostingHours } from "./account-posting";

const prisma = new PrismaClient();

export async function runAutoGenerate() {
  console.log("[auto-generate] Starting daily auto-generation...");

  try {
    const accounts = await prisma.account.findMany({
      where: { autoGenerate: true },
    });

    if (accounts.length === 0) {
      console.log("[auto-generate] No accounts with autoGenerate enabled");
      return;
    }

    for (const account of accounts) {
      if (!account.conceptSheet) {
        console.log(
          `[auto-generate] Skipping ${account.name}: no concept sheet`
        );
        continue;
      }

      try {
        console.log(`[auto-generate] Generating for ${account.name}...`);

        const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
        const res = await fetch(`${baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: account.id,
            count: dailyPostCountFromPostingHours(account.postingHours),
          }),
        });

        const data = await res.json();

        if (res.ok) {
          console.log(
            `[auto-generate] ${account.name}: ${data.count} posts generated`
          );
        } else {
          console.error(
            `[auto-generate] ${account.name}: error - ${data.error}`
          );
        }
      } catch (e) {
        console.error(`[auto-generate] ${account.name}: exception -`, e);
      }
    }

    console.log("[auto-generate] Daily auto-generation completed");
  } catch (e) {
    console.error("[auto-generate] Fatal error:", e);
  }
}
