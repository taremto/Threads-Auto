import { checkClaudeStatus } from "@/lib/claude-cli";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    return NextResponse.json(checkClaudeStatus());
  } catch (e) {
    console.error("[/api/generate/status] error:", e);
    return NextResponse.json(
      {
        ok: false,
        billingBlocked: false,
        platform: process.platform,
        command: null,
        version: null,
        title: "Claudeの確認に失敗しました",
        message: "AI生成の準備状態を確認できませんでした。",
        nextAction:
          "Claudeデスクトップアプリを開いて、このフォルダを選び、「AI生成の準備を確認して」と送ってください。",
        riskEnvNames: [],
        detail: String(e),
      },
      { status: 500 }
    );
  }
}
