import { NextResponse } from "next/server";
import { syncAllCloudAccounts, syncOneAccount } from "@/lib/gas-sync";

/**
 * /api/cloud/sync
 *
 * GET ?accountId=<id>  特定アカウントのみ同期
 * GET                  全クラウドオフロード有効アカウントを同期
 *
 * 起動時は instrumentation.ts の cron でも自動実行される。
 * これは手動同期ボタンや「今すぐ同期」UI からの呼び出し用。
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const accountId = url.searchParams.get("accountId");
    if (accountId) {
      const r = await syncOneAccount(accountId);
      return NextResponse.json(r);
    }
    const all = await syncAllCloudAccounts();
    return NextResponse.json({ count: all.length, results: all });
  } catch (e) {
    console.error("[/api/cloud/sync] error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// 手動同期トリガー（POSTでも同じ）
export async function POST(request: Request) {
  return GET(request);
}
