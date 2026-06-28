import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import {
  describeClaudeCliError,
  runClaude,
  type ClaudeCliError,
} from "@/lib/claude-cli";

/**
 * 投稿AI修正エンドポイント
 * POST body: { postId: string, instruction: string }
 * → 既存の投稿本文 + ユーザーの指示を Claude に渡し、修正後の本文を返す（DBには保存しない）
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { postId, instruction } = body;
    const currentBody =
      typeof body.currentBody === "string" ? body.currentBody.trim() : "";

    if (!postId || !instruction) {
      return NextResponse.json(
        { error: "postId と instruction が必要です" },
        { status: 400 }
      );
    }

    const post = await prisma.post.findUnique({ where: { id: postId } });

    if (!post) {
      return NextResponse.json(
        { error: "投稿が見つかりません" },
        { status: 404 }
      );
    }

    if (currentBody.length > 5000) {
      return NextResponse.json(
        { error: "修正対象の本文が長すぎます" },
        { status: 400 }
      );
    }

    const prompt = buildPostEditPrompt(
      currentBody || post.body,
      String(instruction).trim()
    );

    let result: string;
    try {
      result = await runClaude(prompt);
    } catch (e: unknown) {
      const err = e as ClaudeCliError;
      const rawDetail =
        `${err.stderr || ""}\n${err.stdout || ""}\n${err.message || ""}`.trim();
      console.error("Claude CLI error (post ai-edit):", rawDetail);
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

    return NextResponse.json({ body: result });
  } catch (e) {
    console.error("post ai-edit error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function buildPostEditPrompt(currentBody: string, instruction: string): string {
  return [
    "あなたはThreads投稿の編集アシスタントです。",
    "以下の「現在の投稿本文」を、ユーザーの指示に従って修正してください。",
    "",
    "## ルール",
    "- 修正後の投稿本文だけを出力してください",
    "- 前置き・あいさつ・説明・コードブロック（```）は一切出力しないこと",
    "- 500字以内に収めること",
    "- 改行・空行の入れ方は元の投稿のスタイルを維持すること",
    "- マークダウン記法（**太字**、#見出しなど）は使わないこと",
    "- ハッシュタグ（#〇〇）は使わないこと",
    "",
    "## 現在の投稿本文",
    currentBody,
    "",
    "## ユーザーの修正指示",
    instruction,
    "",
    "## 出力（修正後の投稿本文のみ）",
  ].join("\n");
}
