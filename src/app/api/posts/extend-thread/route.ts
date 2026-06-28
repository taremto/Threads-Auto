import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { parsePosts } from "@/lib/post-parser";
import {
  describeClaudeCliError,
  estimateClaudeGenerationTimeoutMs,
  recordClaudeUsageLimitError,
  runClaude,
  type ClaudeCliError,
} from "@/lib/claude-cli";
import {
  buildExtendThreadPrompt,
  buildRewriteThreadPrompt,
} from "@/lib/extend-thread-prompt";

/**
 * 下書きツリーをAIで拡張する。2モード：
 *  - append : 続きの1投稿だけ生成して末尾に追加（既存はそのまま）
 *  - rewrite: 既存ツリーを同テーマのまま (n+1) 投稿に全文リライトして丸ごと差し替え
 * POST body: { postId, mode?: "append" | "rewrite" }  ← postId はグループ内の任意の1投稿
 *
 * 下書き状態のグループのみ対象。ハード上限6投稿（Threads API伝播ラグで失敗率が上がるため）。
 */
const HARD_MAX_THREAD_POSTS = 6;

export async function POST(request: Request) {
  try {
    const { postId, mode = "append" } = (await request.json()) as {
      postId?: string;
      mode?: "append" | "rewrite";
    };
    if (!postId) {
      return NextResponse.json({ error: "postId required" }, { status: 400 });
    }

    const target = await prisma.post.findUnique({
      where: { id: postId },
      include: { account: true },
    });
    if (!target) {
      return NextResponse.json({ error: "post not found" }, { status: 404 });
    }
    const account = target.account;
    if (!account.conceptSheet) {
      return NextResponse.json(
        { error: "コンセプトシートが未設定です。設定画面から入力してください。" },
        { status: 400 }
      );
    }

    // グループ取得（sortOrder昇順）
    const group = await prisma.post.findMany({
      where: { accountId: target.accountId, groupNo: target.groupNo },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    // 下書き状態のツリーのみ
    if (group.some((p) => p.status !== "draft")) {
      return NextResponse.json(
        {
          error:
            "下書き状態のツリーにだけ追加できます。キューに入れる前の下書きで追加してください。",
        },
        { status: 422 }
      );
    }

    // ハード上限
    if (group.length >= HARD_MAX_THREAD_POSTS) {
      return NextResponse.json(
        {
          error: `1つのツリーは最大${HARD_MAX_THREAD_POSTS}投稿までです（Threads API側の伝播ラグで投稿失敗率が上がるため）。`,
        },
        { status: 422 }
      );
    }

    // ナレッジ（アカウント固有 + 共通）— generate route と同じ条件
    const knowledges = await prisma.knowledge.findMany({
      where: { OR: [{ accountId: target.accountId }, { accountId: null }] },
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
    });
    const rulesKnowledge = knowledges.find((k) => k.type === "rules");
    const structuresKnowledge = knowledges.find((k) => k.type === "structures");
    const customKnowledges = knowledges.filter((k) => k.type === "custom");

    const targetCount = group.length + 1; // rewrite後の投稿数（n+1）
    const promptInput = {
      conceptSheet: account.conceptSheet,
      personaSheet: account.personaSheet || "",
      rules: rulesKnowledge?.content || "",
      structures: structuresKnowledge?.content || "",
      customKnowledges: customKnowledges.map((k) => k.content),
      existingItems: group.map((p) => p.body),
    };
    const prompt =
      mode === "rewrite"
        ? buildRewriteThreadPrompt({ ...promptInput, targetCount })
        : buildExtendThreadPrompt(promptInput);
    const timeoutMs = estimateClaudeGenerationTimeoutMs({
      promptChars: prompt.length,
      count: mode === "rewrite" ? targetCount : 1,
    });

    // Claude CLI 実行（generate route と同じ作法のエラーハンドリング）
    let generatedText: string;
    try {
      generatedText = await runClaude(prompt, { timeoutMs });
    } catch (e: unknown) {
      const err = e as ClaudeCliError;
      const rawDetail = `${err.stderr || ""}\n${err.stdout || ""}\n${err.message || ""}`.trim();
      recordClaudeUsageLimitError(rawDetail);
      console.error("Claude CLI error (extend-thread):", rawDetail);
      return NextResponse.json(
        { error: describeClaudeCliError(rawDetail, err), detail: rawDetail.slice(0, 800) },
        { status: 502 }
      );
    }

    if (!generatedText) {
      return NextResponse.json(
        {
          error:
            "Claudeからの応答が空でした。もう一度試すか、ターミナルで `claude /login` を実行してログイン状態を確認してください。",
        },
        { status: 502 }
      );
    }

    if (mode === "rewrite") {
      // 全文リライト：1ツリーぶんの ■1..■N をパースして、グループを丸ごと差し替える
      const parsed = parsePosts(generatedText, targetCount);
      const items = (parsed[0]?.items || [])
        .map((t) => t.trim())
        .filter(Boolean);
      if (items.length < 2) {
        return NextResponse.json(
          { error: "ツリーの作り直しに失敗しました。もう一度お試しください。" },
          { status: 502 }
        );
      }

      // グループの位置（sortOrder範囲）を保ったまま、件数差ぶんだけ後続をずらして置換する
      const base = group.reduce((m, p) => Math.min(m, p.sortOrder), Infinity);
      const lastSort = group.reduce((m, p) => Math.max(m, p.sortOrder), -Infinity);
      const newCount = items.length;
      const delta = Math.max(0, base + newCount - 1 - lastSort);
      const rec = {
        recommendedHour: group[0].recommendedHour,
        recommendedLabel: group[0].recommendedLabel,
        recommendedReason: group[0].recommendedReason,
      };

      await prisma.$transaction(async (tx) => {
        if (delta > 0) {
          await tx.post.updateMany({
            where: { accountId: target.accountId, sortOrder: { gt: lastSort } },
            data: { sortOrder: { increment: delta } },
          });
        }
        await tx.post.deleteMany({
          where: { accountId: target.accountId, groupNo: target.groupNo },
        });
        await tx.post.createMany({
          data: items.map((b, i) => ({
            accountId: target.accountId,
            groupNo: target.groupNo,
            body: b,
            postType: "thread",
            charCount: b.length,
            status: "draft",
            batchFile: "ai-rewrite",
            sortOrder: base + i,
            recommendedHour: rec.recommendedHour,
            recommendedLabel: rec.recommendedLabel,
            recommendedReason: rec.recommendedReason,
          })),
        });
      });

      return NextResponse.json({ ok: true, mode: "rewrite", groupSize: newCount });
    }

    // append：続きの1投稿を取り出す（本文のみ想定。万一■付きで返っても先頭アイテムを採用）
    const parsed = parsePosts(generatedText, 1);
    const body = parsed[0]?.items[0]?.trim() || generatedText.trim();
    if (!body) {
      return NextResponse.json(
        { error: "生成結果が空でした。もう一度お試しください。" },
        { status: 502 }
      );
    }

    // グループの直後に挿入する。sortOrder はアカウント内の全投稿を通した並び順なので、
    // 単純に「グループ内最大+1」だと次グループの先頭と衝突して後ろに回る。
    // 挿入位置以降を +1 ずらしてスロットを空けてから入れる（原子的に）。
    const insertAt = group.reduce((m, p) => Math.max(m, p.sortOrder), -1) + 1;
    const created = await prisma.$transaction(async (tx) => {
      await tx.post.updateMany({
        where: { accountId: target.accountId, sortOrder: { gte: insertAt } },
        data: { sortOrder: { increment: 1 } },
      });
      return tx.post.create({
        data: {
          accountId: target.accountId,
          groupNo: target.groupNo,
          body,
          postType: "thread",
          charCount: body.length,
          status: "draft",
          batchFile: "ai-extend",
          sortOrder: insertAt,
        },
      });
    });

    // グループ全行を thread に揃える（standalone→thread も成立させる）
    await prisma.post.updateMany({
      where: { accountId: target.accountId, groupNo: target.groupNo },
      data: { postType: "thread" },
    });

    return NextResponse.json({
      ok: true,
      mode: "append",
      post: created,
      groupSize: group.length + 1,
    });
  } catch (e) {
    console.error("POST /api/posts/extend-thread error:", e);
    return NextResponse.json(
      { error: String((e as Error)?.message || e) },
      { status: 500 }
    );
  }
}
