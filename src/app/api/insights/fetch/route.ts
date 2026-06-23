import { NextResponse } from "next/server";
import { fetchAccountInsights } from "@/lib/insights/fetch-runner";

// アカウントのThreads Insightsを取得してDBに反映する（手動更新ボタン用）
// body: { accountId: string, mode?: "recent" | "backfill" }
export async function POST(request: Request) {
  try {
    const { accountId, mode } = await request.json();
    if (!accountId || typeof accountId !== "string") {
      return NextResponse.json({ error: "accountId is required" }, { status: 400 });
    }
    const result = await fetchAccountInsights(accountId, {
      mode: mode === "backfill" ? "backfill" : "recent",
    });
    if (!result.ok && !result.degraded) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: String((e as Error)?.message || e) },
      { status: 500 }
    );
  }
}
