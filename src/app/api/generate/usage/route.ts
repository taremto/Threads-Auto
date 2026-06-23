import { getClaudeUsageStatus, triggerUsageRefreshOnce } from "@/lib/claude-cli";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    // 「再確認 / AI生成」押下時(=refresh=1)だけ、5h/7d 使用率を1回だけ
    // 更新してから返す（直近3分以内に更新済みなら即スキップ）。
    if (refresh) {
      await triggerUsageRefreshOnce();
    }
    return NextResponse.json(getClaudeUsageStatus({ refresh }));
  } catch (e) {
    console.error("[/api/generate/usage] error:", e);
    return NextResponse.json(
      {
        available: false,
        status: "unknown",
        title: "Claude使用量を確認できません",
        message: "使用量の数字を自動取得できませんでした。",
        nextAction:
          "生成はできますが、セッション上限が不安な場合は2〜4投稿だけ生成してください。",
        checkedAt: new Date().toISOString(),
        source: "error",
        fiveHour: { usedPercentage: null, resetsAt: null, resetText: null },
        sevenDay: { usedPercentage: null, resetsAt: null, resetText: null },
        maxRecommendedPosts: null,
        detail: String(e),
      },
      { status: 500 }
    );
  }
}
