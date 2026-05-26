import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { parsePosts, type ParsedPost } from "@/lib/post-parser";
import {
  describeClaudeCliError,
  runClaude,
  type ClaudeCliError,
} from "@/lib/claude-cli";
import {
  fingerprint,
  isTooSimilar,
  maxSimilarity,
  type SimFingerprint,
} from "@/lib/similarity";

// 似すぎた投稿を弾いた後、不足分を作り直す最大回数（=最大 1+2 回 Claude を呼ぶ）
const MAX_REGEN_RETRIES = 2;
// プロンプトに載せる「直近の投稿」の最大件数と、各フックの最大文字数
const AVOID_HOOK_LIMIT = 25;
const AVOID_HOOK_MAXLEN = 60;
// 類似判定の対象にする「直近スレッド」の取得上限
const RECENT_THREAD_GROUPS = 40;

/**
 * AI投稿生成エンドポイント（Claude Code CLI版 — サブスク範囲内）
 * POST body: { accountId, count: number, extraInstructions?: string }
 */
export async function POST(request: Request) {
  try {
    const { accountId, count = 4, extraInstructions } = await request.json();

    if (!accountId) {
      return NextResponse.json(
        { error: "accountId required" },
        { status: 400 }
      );
    }

    // アカウント情報取得
    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });

    if (!account) {
      return NextResponse.json(
        { error: "アカウントが見つかりません" },
        { status: 404 }
      );
    }

    if (!account.conceptSheet) {
      return NextResponse.json(
        { error: "コンセプトシートが未設定です。設定画面から入力してください。" },
        { status: 400 }
      );
    }

    // ナレッジ取得（アカウント固有 + 共通、enabled=true のみ）
    const knowledges = await prisma.knowledge.findMany({
      where: {
        OR: [{ accountId }, { accountId: null }],
        enabled: true,
      },
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
    });

    const rulesKnowledge = knowledges.find((k) => k.type === "rules");
    const structuresKnowledge = knowledges.find((k) => k.type === "structures");
    const customKnowledges = knowledges.filter((k) => k.type === "custom");

    // 投稿時間帯
    let postingHours: number[];
    try {
      postingHours = JSON.parse(account.postingHours);
    } catch {
      postingHours = [6, 12, 18, 21];
    }

    const wantCount = Math.max(1, Math.min(40, Number(count) || 4));
    const userExtra =
      typeof extraInstructions === "string" ? extraInstructions.trim() : "";

    // 直近の投稿（重複回避用）。プロンプトに「これと被らせない」と渡し、
    // かつ生成後の類似チェックの参照集合にも使う。
    const recentThreads = await getRecentThreads(accountId, RECENT_THREAD_GROUPS);
    const existingFps = recentThreads.map((t) => fingerprint(threadToSim(t)));

    const callClaude = (avoidThreads: ParsedPost[], n: number, extra: string) =>
      runClaude(
        buildPrompt(
          account.conceptSheet!,
          rulesKnowledge?.content || "",
          structuresKnowledge?.content || "",
          customKnowledges.map((k) => k.content),
          postingHours,
          n,
          extra,
          buildAvoidHooks(avoidThreads)
        )
      );

    // 1回目の生成（ここでのエラーだけはユーザー向けに詳細を返す）
    let firstText: string;
    try {
      firstText = await callClaude(recentThreads, wantCount, userExtra);
    } catch (e: unknown) {
      const err = e as ClaudeCliError;
      const rawDetail = `${err.stderr || ""}\n${err.stdout || ""}\n${err.message || ""}`.trim();
      console.error("Claude CLI error:", rawDetail);
      return NextResponse.json(
        {
          error: describeClaudeCliError(rawDetail, err),
          detail: rawDetail.slice(0, 800),
        },
        { status: 502 }
      );
    }

    if (!firstText) {
      return NextResponse.json(
        {
          error:
            "Claudeからの応答が空でした。もう一度試すか、ターミナルで `claude /login` を実行してログイン状態を確認してください。",
        },
        { status: 502 }
      );
    }

    const allCandidates: ParsedPost[] = parsePosts(firstText, wantCount);
    if (allCandidates.length === 0) {
      return NextResponse.json(
        {
          error:
            "AIの出力を投稿に分割できませんでした。出力フォーマットが崩れた可能性があります。もう一度「生成開始」を押してみてください。",
          detail: firstText.slice(0, 500),
        },
        { status: 500 }
      );
    }

    // 似すぎたものを弾いて、互いに・既存と被らない投稿だけを選ぶ。
    // 不足分は「これまで採用したもの＋既存」を避けリストに足して作り直す。
    let { selected, selectedFps } = selectDiverse(
      allCandidates,
      existingFps,
      wantCount
    );

    for (
      let attempt = 0;
      selected.length < wantCount && attempt < MAX_REGEN_RETRIES;
      attempt++
    ) {
      const shortfall = wantCount - selected.length;
      let moreText: string;
      try {
        moreText = await callClaude(
          [...recentThreads, ...selected],
          shortfall,
          regenExtra(userExtra)
        );
      } catch (e) {
        // 作り直しの失敗は致命的にしない（採用済みのぶんは活かす）
        console.warn("[generate] regen attempt failed:", e);
        break;
      }
      if (!moreText) break;
      const more = parsePosts(moreText, shortfall);
      if (more.length === 0) break;
      allCandidates.push(...more);
      ({ selected, selectedFps } = selectDiverse(
        allCandidates,
        existingFps,
        wantCount
      ));
    }

    // それでも本数が足りなければ、残り候補から「最も似ていない」順に補充して必ず希望数を返す
    if (selected.length < wantCount) {
      const chosen = new Set(selected);
      const refFps = [...existingFps, ...selectedFps];
      const leftovers = allCandidates
        .filter((c) => !chosen.has(c))
        .map((c) => ({
          post: c,
          score: maxSimilarity(fingerprint(threadToSim(c)), refFps),
        }))
        .sort((a, b) => a.score - b.score);
      for (const { post } of leftovers) {
        if (selected.length >= wantCount) break;
        selected.push(post);
      }
    }

    const posts = selected;
    const filtered = allCandidates.length - posts.length;

    // 最大groupNoとsortOrderを取得
    const [maxGroup, maxSort] = await Promise.all([
      prisma.post.aggregate({
        where: { accountId },
        _max: { groupNo: true },
      }),
      prisma.post.aggregate({
        where: { accountId },
        _max: { sortOrder: true },
      }),
    ]);

    let groupNo = (maxGroup._max.groupNo ?? 0) + 1;
    let sortOrder = (maxSort._max.sortOrder ?? 0) + 1;

    const dbData = [];
    for (const post of posts) {
      if (post.thread && post.items.length > 1) {
        for (const item of post.items) {
          dbData.push({
            accountId,
            groupNo,
            body: item,
            postType: "thread",
            charCount: item.length,
            status: "draft",
            batchFile: "ai-generate",
            sortOrder: sortOrder++,
          });
        }
      } else {
        const body = post.items[0] ?? "";
        dbData.push({
          accountId,
          groupNo,
          body,
          postType: "standalone",
          charCount: body.length,
          status: "draft",
          batchFile: "ai-generate",
          sortOrder: sortOrder++,
        });
      }
      groupNo++;
    }

    const result = await prisma.post.createMany({ data: dbData });

    return NextResponse.json(
      { count: result.count, posts: posts.length, filtered },
      { status: 201 }
    );
  } catch (e) {
    console.error("generate error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ===========================================================
// 重複回避ヘルパー
// ===========================================================

function threadToSim(p: ParsedPost): { hook: string; fullText: string } {
  return { hook: p.items[0] ?? "", fullText: p.items.join("\n") };
}

/** 直近の投稿を groupNo 単位でスレッドに復元して新しい順に返す */
async function getRecentThreads(
  accountId: string,
  maxGroups: number
): Promise<ParsedPost[]> {
  const rows = await prisma.post.findMany({
    where: { accountId },
    orderBy: { createdAt: "desc" },
    take: 400,
    select: { groupNo: true, body: true, sortOrder: true },
  });
  const byGroup = new Map<number, { body: string; sortOrder: number }[]>();
  const order: number[] = [];
  for (const r of rows) {
    if (!byGroup.has(r.groupNo)) {
      byGroup.set(r.groupNo, []);
      order.push(r.groupNo);
    }
    byGroup.get(r.groupNo)!.push({ body: r.body, sortOrder: r.sortOrder });
  }
  const threads: ParsedPost[] = [];
  for (const g of order.slice(0, maxGroups)) {
    const items = byGroup
      .get(g)!
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((x) => x.body)
      .filter((b) => b.trim().length > 0);
    if (items.length) threads.push({ thread: items.length > 1, items });
  }
  return threads;
}

/** プロンプトに載せる「避けるべき書き出し」の一覧（短く整形） */
function buildAvoidHooks(threads: ParsedPost[]): string[] {
  const seen = new Set<string>();
  const hooks: string[] = [];
  for (const t of threads) {
    const raw = (t.items[0] ?? "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const h =
      raw.length > AVOID_HOOK_MAXLEN
        ? raw.slice(0, AVOID_HOOK_MAXLEN) + "…"
        : raw;
    if (seen.has(h)) continue;
    seen.add(h);
    hooks.push(h);
    if (hooks.length >= AVOID_HOOK_LIMIT) break;
  }
  return hooks;
}

/** 候補から、既存・互いと被らないスレッドを希望数まで選ぶ */
function selectDiverse(
  candidates: ParsedPost[],
  existingFps: SimFingerprint[],
  want: number
): { selected: ParsedPost[]; selectedFps: SimFingerprint[] } {
  const selected: ParsedPost[] = [];
  const selectedFps: SimFingerprint[] = [];
  for (const c of candidates) {
    if (selected.length >= want) break;
    const fp = fingerprint(threadToSim(c));
    const dup =
      existingFps.some((e) => isTooSimilar(fp, e)) ||
      selectedFps.some((e) => isTooSimilar(fp, e));
    if (dup) continue;
    selected.push(c);
    selectedFps.push(fp);
  }
  return { selected, selectedFps };
}

/** 作り直し（不足分の再生成）時に足す指示 */
function regenExtra(userExtra: string): string {
  const note =
    "※これは作り直しです。上の「直近で生成済みの投稿」と、書き出し・テーマ・切り口・構成・語尾のリズムが1つも被らない、まったく新しい角度の投稿だけを作ること。同じネタの言い換え・焼き直しは禁止。";
  return userExtra ? `${userExtra}\n\n${note}` : note;
}

// ===========================================================
// プロンプト構築
// ===========================================================
function buildPrompt(
  conceptSheet: string,
  rules: string,
  structures: string,
  customKnowledges: string[],
  postingHours: number[],
  count: number,
  extraInstructions: string = "",
  recentHooks: string[] = []
): string {
  const parts = [
    "あなたはSNSコンテンツの専門家です。以下のコンセプト定義・ルール・構成パターンに基づき、そのまま投稿できる品質のThreads投稿を生成してください。",
    "",
    "## コンセプトシート（ペルソナ・語彙・テーマ）",
    conceptSheet,
    "",
  ];

  if (extraInstructions) {
    parts.push(
      "## 🔴 今回の追加指示（このバッチでのみ最優先で従うこと）",
      "下記はユーザーが今回の生成のために明示的に指定した追加指示です。",
      "コンセプトシート・ナレッジ・生成ルールと矛盾する場合は **この追加指示を優先** すること。",
      "",
      extraInstructions,
      ""
    );
  }

  if (rules) {
    parts.push("## 投稿生成ルール", rules, "");
  }

  if (structures) {
    parts.push("## 投稿構成パターン集", structures, "");
  }

  for (const custom of customKnowledges) {
    parts.push("## 追加ナレッジ", custom, "");
  }

  if (recentHooks.length > 0) {
    parts.push(
      "## 🚫 直近で生成済みの投稿（これらと絶対に被らせないこと）",
      "以下はこのアカウントで最近作った投稿の書き出しです。今回作る投稿は、これらと次のすべてが被らないようにすること：",
      "- 書き出し・フックの言い回し（同じ入り方をしない）",
      "- テーマ・話題・切り口（同じネタの焼き直しをしない）",
      "- 構成パターン・語尾・句読点のリズム",
      "同じ切り口を別の言葉で言い換えただけ、も「被り」とみなす。下記とかぶる案しか浮かばないなら、別のテーマ・別の構成に切り替えること。",
      "",
      ...recentHooks.map((h, i) => `${i + 1}. ${h}`),
      ""
    );
  }

  parts.push(
    "## 品質基準（妥協禁止）",
    "投稿は「型は守れているが既視感がある」状態にならないこと。バズるために以下を厳守：",
    "",
    "### フック（1投稿目）の必須要件",
    "- 既存インフルエンサーが使い古した定型表現を避ける（例: 『2種類の人間がいる』『才能の差じゃない』『悪いこと言わないから』『断言します』『あなたの努力が報われないのは〜だけ』など、Threads上で過去30日に頻出するパターンは使用禁止）",
    "- 業界内の固有名詞だけで完結させない（例: 稼ぐ系で『楽天アフィvs退職代行』のような比較だけで終わらせない）。業界外からのアナロジー・比喩を1本に1つは含めること",
    "- 数字を入れるなら『個人的な実績数字』『具体的な固有名詞』を優先（一般論の数字より遥かに強い）",
    "- 結論の予測がつく定型ロジックで埋めない。1行目で予想を裏切る切り口を1つ仕込む",
    "",
    "### 表現の制約",
    "- AI感のある表現禁止: **太字**、【見出し】、箇条書き連発、過度に整った論理展開",
    "- ですます調とタメ口の混在で生っぽさを出す",
    "- 接続詞は口語化（『また』→『あと』、『しかし』→『でも』、『さらに』→『で、』）",
    "- 結論や本題を匂わせて未完了で終わる『、』止めを活用",
    "",
    "### 反復回避",
    "- 1バッチ内で同じフック型を2回使わない",
    "- 1バッチ内で同じテーマカテゴリを3回以上使わない",
    "- 同じ語尾・同じ句読点リズムを連続させない",
    "",
    "## 生成指示",
    `- ${count}本のスレッド投稿（ツリー投稿）を生成する。**全件スレッド型で出力すること。単体投稿は1本も含めない。**`,
    `- 投稿時間帯: ${postingHours.map((h) => `${h}時`).join("、")}`,
    "- 各スレッドは **2投稿（基本）または3投稿（深い話・ステップ系のみ）** で構成する。**4投稿以上は厳禁**（読者離脱率が急増し、API側のリプライ伝播ラグで投稿失敗率も上がるため）",
    "- 2投稿型: ■1 フック＋橋渡し / ■2 本編＋締め（CTAあれば最後に自然に溶け込ませる）",
    "- 3投稿型: ■1 フック / ■2 本編 / ■3 締め＋CTA",
    "- 各投稿（1スレッド内の各リプライ）は200〜500字",
    "- 1バッチ内で同じフック型・同じ構成パターンを2回使わない",
    "",
    "## 出力フォーマット（絶対厳守 — この通りに、本文だけを出力）",
    "前置き・あいさつ・説明・採点・コードブロック（```）は一切出力しないこと。下記の形をそのまま守ること：",
    "",
    "■1",
    "（1スレッド目の1投稿目の本文。フック＋橋渡し。200〜500字）",
    "",
    "■2",
    "（1スレッド目の2投稿目の本文。本編＋締め。200〜500字）",
    "",
    "=====",
    "",
    "■1",
    "（2スレッド目の1投稿目の本文）",
    "",
    "■2",
    "（2スレッド目の2投稿目の本文）",
    "",
    "=====",
    "",
    `（…これを合計 ${count} スレッド分くり返す）`,
    "",
    "### フォーマット規則（違反禁止）",
    "- スレッドとスレッドの区切りは、必ず半角イコールを5つ並べた行「=====」だけにする（他の区切り線・見出しは使わない）",
    "- 各投稿の先頭は必ず行頭に「■1」「■2」（深い話のみ「■3」まで）。■4以上は禁止",
    "- 「投稿1:」「スレッド1」「1本目」のような見出しラベルは付けない。■マーカーだけで区切る",
    "- 本文中に **太字**、## 見出し、- や 1. の箇条書き、表 などのマークダウン記法を使わない",
    "- 1スレッドにつき ■マーカーは2個（または3個）。必ず複数の■を含めること",
    `- 最終的に「=====」で区切られたスレッドのかたまりが ${count} 個になるように出力する`
  );

  if (extraInstructions) {
    parts.push(
      "",
      "## 🔴 もう一度: 今回の追加指示（最優先・再掲）",
      "生成を始める前に、もう一度この指示を読み返し、すべての投稿に確実に反映すること:",
      "",
      extraInstructions
    );
  }

  return parts.join("\n");
}
