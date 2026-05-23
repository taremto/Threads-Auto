import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import {
  describeClaudeCliError,
  runClaude,
  type ClaudeCliError,
} from "@/lib/claude-cli";

/**
 * ナレッジAI編集エンドポイント
 * POST body: { knowledgeId: string, instruction: string }
 * → 既存のナレッジ内容 + ユーザーの指示を Claude に渡し、編集後の内容を返す
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // ヘルスチェック（カスタマイズ適用確認用）
    if (body._healthcheck) {
      return NextResponse.json({ ok: true });
    }

    const { knowledgeId, instruction } = body;

    if (!knowledgeId || !instruction) {
      return NextResponse.json(
        { error: "knowledgeId と instruction が必要です" },
        { status: 400 }
      );
    }

    const knowledge = await prisma.knowledge.findUnique({
      where: { id: knowledgeId },
    });

    if (!knowledge) {
      return NextResponse.json(
        { error: "ナレッジが見つかりません" },
        { status: 404 }
      );
    }

    // プロンプト構築
    const prompt = buildKnowledgeEditPrompt(
      knowledge.title,
      knowledge.content,
      instruction
    );

    // Claude CLI 実行
    let result: string;
    try {
      result = await runClaude(prompt);
    } catch (e: unknown) {
      const err = e as ClaudeCliError;
      const rawDetail = `${err.stderr || ""}\n${err.stdout || ""}\n${err.message || ""}`.trim();
      console.error("Claude CLI error (knowledge ai-edit):", rawDetail);
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

    // 結果を返す（まだDBには保存しない — ユーザーがプレビューして確認してから保存）
    return NextResponse.json({ content: result });
  } catch (e) {
    console.error("knowledge ai-edit error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function buildKnowledgeEditPrompt(
  title: string,
  currentContent: string,
  instruction: string
): string {
  return [
    "あなたはSNS運用のナレッジ管理アシスタントです。",
    "以下の「現在のナレッジ」を、ユーザーの指示に従って編集・加筆・修正してください。",
    "",
    "## ルール",
    "- 指示に従って内容を編集し、編集後のナレッジ全文だけを出力してください",
    "- 前置き・あいさつ・説明・コードブロック（```）は一切出力しないこと",
    "- 元の構造やフォーマット（見出し・箇条書き等）は、指示で変更を求められない限りそのまま維持すること",
    "- 「追加して」の場合は既存内容を残したまま追記。「書き換えて」の場合は該当箇所を置換",
    "- 出力は編集後のナレッジ本文のみ（「以下が編集結果です」のような前置きは禁止）",
    "",
    `## ナレッジタイトル: ${title}`,
    "",
    "## 現在のナレッジ内容",
    currentContent,
    "",
    "## ユーザーの編集指示",
    instruction,
    "",
    "## 出力（編集後のナレッジ全文のみ）",
  ].join("\n");
}
