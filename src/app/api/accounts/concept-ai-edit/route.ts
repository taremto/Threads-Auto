import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import {
  describeClaudeCliError,
  runClaude,
  type ClaudeCliError,
} from "@/lib/claude-cli";

/**
 * コンセプトシートAI編集エンドポイント
 * POST body: { accountId: string, instruction: string, currentContent?: string }
 * → 既存のコンセプトシート + ユーザー指示を Claude に渡し、編集後の内容を返す
 *   currentContent が渡された場合はそれを優先（編集中の未保存内容を反映できる）
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // ヘルスチェック（カスタマイズ適用確認用）
    if (body._healthcheck) {
      return NextResponse.json({ ok: true });
    }

    const { accountId, instruction, currentContent } = body;

    if (!accountId || !instruction) {
      return NextResponse.json(
        { error: "accountId と instruction が必要です" },
        { status: 400 }
      );
    }

    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      return NextResponse.json(
        { error: "アカウントが見つかりません" },
        { status: 404 }
      );
    }

    // currentContent が指定されていればそれを使う（編集中の未保存内容）
    const baseContent =
      typeof currentContent === "string" ? currentContent : account.conceptSheet || "";

    const prompt = buildConceptEditPrompt(
      account.name,
      baseContent,
      instruction
    );

    let result: string;
    try {
      result = await runClaude(prompt);
    } catch (e: unknown) {
      const err = e as ClaudeCliError;
      const rawDetail = `${err.stderr || ""}\n${err.stdout || ""}\n${err.message || ""}`.trim();
      console.error("Claude CLI error (concept ai-edit):", rawDetail);
      return NextResponse.json(
        {
          error: describeClaudeCliError(rawDetail, err),
          detail: rawDetail.slice(0, 800),
        },
        { status: 502 }
      );
    }

    if (!result) {
      return NextResponse.json(
        { error: "Claudeからの応答が空でした。もう一度試してください。" },
        { status: 502 }
      );
    }

    return NextResponse.json({ content: result });
  } catch (e) {
    console.error("concept ai-edit error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function buildConceptEditPrompt(
  accountName: string,
  currentContent: string,
  instruction: string
): string {
  const hasContent = currentContent.trim().length > 0;
  return [
    "あなたはSNS運用のコンセプトシート作成アシスタントです。",
    hasContent
      ? "以下の「現在のコンセプトシート」を、ユーザーの指示に従って編集・加筆・修正してください。"
      : "現在のコンセプトシートはまだ空です。ユーザーの指示に従って、コンセプトシートを新規作成してください。",
    "",
    "## ルール",
    "- 指示に従って内容を編集し、編集後のコンセプトシート全文だけを出力してください",
    "- 前置き・あいさつ・説明・コードブロック（```）は一切出力しないこと",
    "- 元の構造やフォーマット（見出し・箇条書き等）は、指示で変更を求められない限りそのまま維持すること",
    "- 「追加して」の場合は既存内容を残したまま追記。「書き換えて」の場合は該当箇所を置換",
    "- 出力は編集後のコンセプトシート本文のみ（「以下が編集結果です」のような前置きは禁止）",
    "- コンセプトシートはAI投稿生成時にペルソナ・語彙・テーマの定義として使われる。具体的・行動可能・差別化された内容になるよう編集すること",
    "",
    `## アカウント名: ${accountName}`,
    "",
    hasContent ? "## 現在のコンセプトシート" : "## 現在のコンセプトシート（空）",
    currentContent || "(まだ何も書かれていません)",
    "",
    "## ユーザーの編集指示",
    instruction,
    "",
    "## 出力（編集後のコンセプトシート全文のみ）",
  ].join("\n");
}
