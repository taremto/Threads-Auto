export type RecommendedPostingTime = {
  hour: number;
  label: string;
  reason: string;
};

type RecommendedPostingOptions = {
  postTexts?: string[];
  rng?: () => number;
  // 実データ由来の推奨枠（best-hours.ts）。あれば本文キーワードより優先する。
  preferred?: {
    hours: number[]; // 実績の良い順（postingHours の部分集合）
    stats: Record<number, { avgEr: number; avgViews: number; count: number }>;
  } | null;
};

type PersonaRule = {
  label: string;
  keywords: string[];
  hours: number[];
};

type ContentRule = {
  label: string;
  keywords: string[];
  hours: number[];
  reason: string;
};

const DEFAULT_HOURS = [7, 12, 18, 21];

const PERSONA_RULES: PersonaRule[] = [
  {
    label: "会社員・ビジネス層",
    keywords: [
      "会社員",
      "ビジネス",
      "副業",
      "起業",
      "経営",
      "マーケ",
      "営業",
      "仕事",
      "キャリア",
      "フリーランス",
      "個人事業",
      "sns運用",
    ],
    hours: [7, 12, 18, 21],
  },
  {
    label: "子育て・家庭層",
    keywords: ["ママ", "主婦", "育児", "子育て", "家事", "家庭", "親子"],
    hours: [9, 13, 21, 22],
  },
  {
    label: "学生・若年層",
    keywords: ["学生", "大学", "高校", "受験", "勉強", "就活", "若者", "10代", "20代"],
    hours: [8, 12, 17, 22],
  },
  {
    label: "クリエイター・AI関心層",
    keywords: [
      "ai",
      "生成ai",
      "クリエイター",
      "デザイン",
      "動画",
      "画像生成",
      "コンテンツ",
      "創作",
    ],
    hours: [10, 13, 20, 22],
  },
  {
    label: "美容・ライフスタイル層",
    keywords: [
      "美容",
      "ダイエット",
      "恋愛",
      "ファッション",
      "ライフスタイル",
      "健康",
      "暮らし",
    ],
    hours: [8, 12, 20, 22],
  },
];

const CONTENT_RULES: ContentRule[] = [
  {
    label: "朝に行動しやすい内容",
    keywords: [
      "朝",
      "起き",
      "目覚め",
      "通勤",
      "出勤",
      "午前",
      "習慣",
      "今日から",
      "顔を洗",
    ],
    hours: [7, 8, 9],
    reason: "朝の行動に移しやすい内容なので、1日の始まりに読まれやすい時間を選んでいます。",
  },
  {
    label: "昼休みに読みやすい内容",
    keywords: ["昼", "ランチ", "休憩", "昼休み", "家事", "買い物", "移動中"],
    hours: [12, 13],
    reason: "短い休憩中に読みやすい内容なので、昼の空き時間に合わせています。",
  },
  {
    label: "仕事終わりに刺さる内容",
    keywords: [
      "仕事",
      "会社",
      "働",
      "副業",
      "起業",
      "経営",
      "営業",
      "キャリア",
      "帰宅",
      "疲れ",
    ],
    hours: [18, 19, 20, 21],
    reason: "仕事終わりに振り返りやすい内容なので、夜の前半を優先しています。",
  },
  {
    label: "夜にじっくり読まれやすい内容",
    keywords: [
      "夜",
      "寝る前",
      "眠",
      "不安",
      "悩み",
      "モヤモヤ",
      "恋愛",
      "浄化",
      "占い",
      "氣",
      "石",
      "肩",
      "癒し",
      "内省",
    ],
    hours: [20, 21, 22],
    reason: "落ち着いて自分ごと化されやすい内容なので、夜に読まれやすい時間を選んでいます。",
  },
];

export function normalizePostingHours(value: unknown): number[] {
  if (!Array.isArray(value)) return DEFAULT_HOURS;
  const hours = [...new Set(value.map(Number))]
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);
  return hours.length > 0 ? hours : DEFAULT_HOURS;
}

export function buildRecommendedPostingPlan(
  conceptSheet: string | null | undefined,
  postingHours: number[],
  count: number,
  options: RecommendedPostingOptions = {}
): RecommendedPostingTime[] {
  const persona = detectPersona(conceptSheet || "");
  const availableHours = normalizePostingHours(postingHours);
  const rng = options.rng || Math.random;
  const postTexts = options.postTexts || [];
  const preferred = options.preferred;
  const usePreferred = !!(preferred && preferred.hours.length > 0);
  // 実データがある時は、実績トップ2に集中させつつ recentlyUsed で交互に散らす。
  const preferredTarget = usePreferred ? preferred!.hours.slice(0, 2) : [];
  const recentlyUsed: number[] = [];

  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    if (usePreferred) {
      const hour = pickRecommendedHour(preferredTarget, availableHours, rng, recentlyUsed);
      recentlyUsed.push(hour);
      if (recentlyUsed.length > 2) recentlyUsed.shift();
      const s = preferred!.stats[hour];
      return {
        hour,
        label: `${hour.toString().padStart(2, "0")}:00前後`,
        reason: s
          ? `あなたの過去投稿だと${hour}時台が平均ER ${s.avgEr}%・平均${s.avgViews.toLocaleString("en-US")}閲覧でよく伸びています（実データから選択）。`
          : `あなたの過去の実績が良い時間帯から選びました（実データから選択）。`,
      };
    }

    const contentRule = detectContentRule(postTexts[index] || "");
    const targetHours = contentRule?.hours || persona.hours || DEFAULT_HOURS;
    const hour = pickRecommendedHour(targetHours, availableHours, rng, recentlyUsed);
    recentlyUsed.push(hour);
    if (recentlyUsed.length > 2) recentlyUsed.shift();

    return {
      hour,
      label: `${hour.toString().padStart(2, "0")}:00前後`,
      reason:
        contentRule?.reason ||
        `${persona.label}がスマホを見やすい時間帯から、今回はランダムに選んでいます。`,
    };
  });
}

function detectPersona(concept: string): PersonaRule {
  const lower = concept.toLowerCase();
  let best: PersonaRule | null = null;
  let bestScore = 0;

  for (const rule of PERSONA_RULES) {
    const score = rule.keywords.reduce(
      (sum, keyword) => sum + (lower.includes(keyword.toLowerCase()) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  return best || {
    label: "ターゲット層",
    keywords: [],
    hours: DEFAULT_HOURS,
  };
}

function detectContentRule(text: string): ContentRule | null {
  const lower = text.toLowerCase();
  let best: ContentRule | null = null;
  let bestScore = 0;

  for (const rule of CONTENT_RULES) {
    const score = rule.keywords.reduce(
      (sum, keyword) => sum + (lower.includes(keyword.toLowerCase()) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  return best;
}

function pickRecommendedHour(
  targetHours: number[],
  availableHours: number[],
  rng: () => number,
  recentlyUsed: number[]
): number {
  const ranked = availableHours
    .map((hour) => ({
      hour,
      distance: Math.min(
        ...targetHours.map((targetHour) => circularHourDistance(hour, targetHour))
      ),
    }))
    .sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.hour - b.hour;
    });

  const bestDistance = ranked[0]?.distance ?? 0;
  const acceptableDistance = bestDistance <= 1 ? bestDistance + 2 : bestDistance;
  const compatible = ranked.filter((item) => item.distance <= acceptableDistance);
  const fresh =
    compatible.length > 1
      ? compatible.filter((item) => !recentlyUsed.includes(item.hour))
      : compatible;
  const pool = fresh.length > 0 ? fresh : compatible;
  const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[index]?.hour ?? availableHours[0];
}

function circularHourDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 24 - diff);
}
