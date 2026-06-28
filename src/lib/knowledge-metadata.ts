export type PriorityAxis =
  | "format"
  | "operations"
  | "strategy"
  | "cta"
  | "tone"
  | "material";

export const AXIS_LABELS: Record<PriorityAxis, string> = {
  format: "形式・出力制約",
  operations: "可変の運用値",
  strategy: "戦略・大前提",
  cta: "案件CTA",
  tone: "トーン・人格",
  material: "素材",
};

export const AXIS_ORDER: PriorityAxis[] = [
  "format",
  "operations",
  "strategy",
  "cta",
  "tone",
  "material",
];

export type KnowledgeMapping = {
  titlePattern: RegExp;
  axis: PriorityAxis;
  steps: number[];
  priority: number;
};

export const KNOWLEDGE_MAPPINGS: KnowledgeMapping[] = [
  { titlePattern: /上書きルール/, axis: "format", steps: [8, 9, 13], priority: 1 },
  { titlePattern: /投稿構成パターン/, axis: "format", steps: [8], priority: 2 },
  { titlePattern: /投稿前チェックリスト/, axis: "format", steps: [11], priority: 3 },
  { titlePattern: /現行運用パラメータ/, axis: "operations", steps: [5, 6], priority: 1 },
  { titlePattern: /運用指南書/, axis: "strategy", steps: [0], priority: 1 },
  { titlePattern: /CTA用ナレッジ|CTA設計/, axis: "cta", steps: [6], priority: 1 },
  { titlePattern: /案件接続ルール/, axis: "cta", steps: [6], priority: 2 },
  { titlePattern: /フォロー誘導CTA/, axis: "cta", steps: [1], priority: 3 },
  { titlePattern: /コアルール/, axis: "tone", steps: [1, 9, 13], priority: 1 },
  { titlePattern: /アカウントコンセプト/, axis: "tone", steps: [2, 4, 13], priority: 2 },
  { titlePattern: /ペルソナ設計/, axis: "tone", steps: [2, 4], priority: 3 },
  { titlePattern: /専門ナレッジ/, axis: "material", steps: [3, 7], priority: 1 },
  { titlePattern: /悩み素材バンク/, axis: "material", steps: [2, 3, 7, 9], priority: 2 },
  { titlePattern: /バズフックパターン/, axis: "material", steps: [5, 9], priority: 3 },
  { titlePattern: /市場フックパターン/, axis: "material", steps: [5, 9], priority: 4 },
  { titlePattern: /発信者体験談/, axis: "material", steps: [6], priority: 5 },
  { titlePattern: /ナレッジDB/, axis: "material", steps: [10], priority: 6 },
];

export function findKnowledgeMapping(title: string): KnowledgeMapping | null {
  return KNOWLEDGE_MAPPINGS.find((m) => m.titlePattern.test(title)) ?? null;
}
