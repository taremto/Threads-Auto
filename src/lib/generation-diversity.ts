import type { ParsedPost } from "./post-parser";

export type HistoricalPost = {
  groupNo: number;
  body: string;
  createdAt: Date | string;
};

export type DiversityPlanItem = {
  index: number;
  type: string;
  scene: string;
  emotion: string;
  instruction: string;
};

export type SimilarityResult = {
  kept: Array<{ post: ParsedPost; plan: DiversityPlanItem }>;
  skipped: Array<{
    post: ParsedPost;
    plan: DiversityPlanItem;
    reason: string;
    score: number;
    matchedExcerpt: string;
  }>;
};

const POST_TYPE_ROTATION = [
  {
    type: "共感の具体シーン型",
    instruction: "読者が昨日か今日に体験していそうな職場の一場面から入る",
  },
  {
    type: "逆説・常識ずらし型",
    instruction: "一般論の逆を言い、あとから納得できる理由を出す",
  },
  {
    type: "失敗談・後悔型",
    instruction: "やってしまいがちな我慢や判断ミスを小さな後悔として描く",
  },
  {
    type: "判断軸・チェック型",
    instruction: "転職や退職を考える前に見る判断基準を1つ示す",
  },
  {
    type: "質問・内なる声型",
    instruction: "読者の頭の中の独り言を質問としてそのまま出す",
  },
  {
    type: "比喩・たとえ話型",
    instruction: "職場以外の比喩を1つ使って、状況を見えやすくする",
  },
  {
    type: "小さな行動・手順型",
    instruction: "今日できる小さな行動を1つだけ具体化する",
  },
  {
    type: "比較・二択型",
    instruction: "似ている2つの選択肢を比べ、読者の判断を助ける",
  },
] as const;

const SCENE_ROTATION = [
  "朝、駅のホームで会社名を見ただけで胃が重くなる瞬間",
  "上司からのSlack通知で手が止まる瞬間",
  "1on1前に言うことを何度も消している場面",
  "同期の昇進報告を見て、自分だけ遅れている気がする夜",
  "金曜夜なのに月曜のことを考えて休めない場面",
  "求人票を開いたまま、応募ボタンだけ押せない場面",
  "親や友達に『まだ早いんじゃない』と言われて迷う場面",
  "ミスよりも上司への報告が怖くて固まる場面",
] as const;

const EMOTION_ROTATION = [
  "甘えかもしれない不安",
  "逃げ癖と思われる怖さ",
  "誰にも相談できない孤独",
  "自分だけ弱い気がする焦り",
  "辞めたいのに動けない罪悪感",
  "転職サービスに登録する抵抗感",
  "壊れる前に逃げたい切迫感",
  "何がつらいのか言語化できない混乱",
] as const;

const SIMILARITY_THRESHOLD = 0.48;
const OPENING_SIMILARITY_THRESHOLD = 0.72;

export function buildDiversityPlan(
  count: number,
  historicalThreadCount: number
): DiversityPlanItem[] {
  const offset = historicalThreadCount % POST_TYPE_ROTATION.length;
  return Array.from({ length: count }, (_, i) => {
    const type = POST_TYPE_ROTATION[(offset + i) % POST_TYPE_ROTATION.length];
    return {
      index: i + 1,
      type: type.type,
      instruction: type.instruction,
      scene: SCENE_ROTATION[(historicalThreadCount + i) % SCENE_ROTATION.length],
      emotion:
        EMOTION_ROTATION[(historicalThreadCount + i) % EMOTION_ROTATION.length],
    };
  });
}

export function groupHistoricalPosts(posts: HistoricalPost[]): HistoricalPost[] {
  const grouped = new Map<
    number,
    { groupNo: number; bodies: string[]; createdAt: Date | string }
  >();

  for (const post of posts) {
    const current = grouped.get(post.groupNo);
    if (current) {
      current.bodies.push(post.body);
      if (new Date(post.createdAt) > new Date(current.createdAt)) {
        current.createdAt = post.createdAt;
      }
      continue;
    }

    grouped.set(post.groupNo, {
      groupNo: post.groupNo,
      bodies: [post.body],
      createdAt: post.createdAt,
    });
  }

  return Array.from(grouped.values())
    .map((post) => ({
      groupNo: post.groupNo,
      body: post.bodies.join("\n\n"),
      createdAt: post.createdAt,
    }))
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
}

export function buildDiversityPromptSection(
  plan: DiversityPlanItem[],
  historicalPosts: HistoricalPost[]
): string {
  const recentExamples = historicalPosts
    .slice(0, 12)
    .map((post, i) => `${i + 1}. ${toExcerpt(post.body, 180)}`)
    .join("\n");

  const rotationLines = plan
    .map(
      (item) =>
        `${item.index}本目: ${item.type} / 場面: ${item.scene} / 感情: ${item.emotion} / 指示: ${item.instruction}`
    )
    .join("\n");

  const parts = [
    "## 類似回避・投稿タイプローテーション（最優先）",
    "今回の生成では、下記のローテーションを1本目から順番に必ず割り当てること。",
    "各スレッドの本文内にタイプ名や場面名のラベルは書かない。本文の切り口として自然に反映すること。",
    "",
    rotationLines,
    "",
    "### 過去投稿との類似禁止",
    "下記の過去投稿と、書き出し・結論・悩みの切り口・具体場面・語尾のリズムが近い投稿は作らないこと。",
    "同じ『辞めてもいい』『無理しないで』型の結論に寄せず、毎回ちがう判断軸・感情・場面で着地させること。",
    "",
    recentExamples || "過去投稿はまだありません。",
  ];

  return parts.join("\n");
}

export function filterSimilarPosts(
  generatedPosts: ParsedPost[],
  plan: DiversityPlanItem[],
  historicalPosts: HistoricalPost[]
): SimilarityResult {
  const kept: SimilarityResult["kept"] = [];
  const skipped: SimilarityResult["skipped"] = [];
  const comparisonPool = historicalPosts.map((post) => post.body);

  generatedPosts.forEach((post, i) => {
    const body = post.items.join("\n\n");
    const planItem = plan[i] ?? plan[plan.length - 1];
    const match = findMostSimilar(body, comparisonPool);
    const openingMatch = findMostSimilarOpening(body, comparisonPool);
    const duplicateInBatch = findMostSimilar(
      body,
      kept.map((item) => item.post.items.join("\n\n"))
    );

    const strongestScore = Math.max(
      match.score,
      openingMatch.score,
      duplicateInBatch.score
    );

    if (
      match.score >= SIMILARITY_THRESHOLD ||
      openingMatch.score >= OPENING_SIMILARITY_THRESHOLD ||
      duplicateInBatch.score >= SIMILARITY_THRESHOLD
    ) {
      skipped.push({
        post,
        plan: planItem,
        reason:
          duplicateInBatch.score >= SIMILARITY_THRESHOLD
            ? "同じ生成バッチ内で似ています"
            : "過去投稿と似ています",
        score: strongestScore,
        matchedExcerpt: toExcerpt(
          duplicateInBatch.score >= SIMILARITY_THRESHOLD
            ? duplicateInBatch.text
            : match.score >= openingMatch.score
              ? match.text
              : openingMatch.text,
          120
        ),
      });
      return;
    }

    kept.push({ post, plan: planItem });
  });

  return { kept, skipped };
}

function findMostSimilar(text: string, candidates: string[]) {
  let best = { score: 0, text: "" };
  for (const candidate of candidates) {
    const score = ngramDice(text, candidate, 3);
    if (score > best.score) best = { score, text: candidate };
  }
  return best;
}

function findMostSimilarOpening(text: string, candidates: string[]) {
  const opening = normalizeText(text).slice(0, 80);
  let best = { score: 0, text: "" };
  if (!opening) return best;

  for (const candidate of candidates) {
    const candidateOpening = normalizeText(candidate).slice(0, 80);
    const score = ngramDice(opening, candidateOpening, 2);
    if (score > best.score) best = { score, text: candidate };
  }
  return best;
}

function ngramDice(a: string, b: string, size: number): number {
  const left = toNgrams(normalizeText(a), size);
  const right = toNgrams(normalizeText(b), size);
  if (left.size === 0 || right.size === 0) return 0;

  let overlap = 0;
  for (const gram of left) {
    if (right.has(gram)) overlap++;
  }

  return (2 * overlap) / (left.size + right.size);
}

function toNgrams(text: string, size: number): Set<string> {
  const grams = new Set<string>();
  if (text.length < size) {
    if (text) grams.add(text);
    return grams;
  }
  for (let i = 0; i <= text.length - size; i++) {
    grams.add(text.slice(i, i + size));
  }
  return grams;
}

function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[「」『』【】（）()［\]\[\]#*■◆◇・、。,.!?！？\s]/g, "")
    .trim();
}

function toExcerpt(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength)}...`
    : compact;
}
