export type StepDefinition = {
  step: number;
  label: string;
  title: string;
  knowledgeKeys: string[];
};

export const STEP_DEFINITIONS: StepDefinition[] = [
  { step: 0, label: "STEP0", title: "指南書の大前提確認", knowledgeKeys: ["運用指南書"] },
  { step: 1, label: "STEP1", title: "Layer決定", knowledgeKeys: ["コアルール"] },
  { step: 2, label: "STEP2", title: "悩み起点選択", knowledgeKeys: ["悩み素材バンク", "アカウントコンセプト", "ペルソナ設計"] },
  { step: 3, label: "STEP3", title: "悩みカテゴリ仮置き", knowledgeKeys: ["専門ナレッジ 00", "悩み素材バンク"] },
  { step: 4, label: "STEP4", title: "ペルソナ照合", knowledgeKeys: ["アカウントコンセプト", "ペルソナ設計"] },
  { step: 5, label: "STEP5", title: "フック型・心理技法決定", knowledgeKeys: ["バズフックパターン集", "市場フックパターン集", "現行運用パラメータ"] },
  { step: 6, label: "STEP6", title: "案件照合（L3のみ）", knowledgeKeys: ["現行運用パラメータ", "案件接続ルール", "CTA設計ファイル", "発信者体験談ナレッジ"] },
  { step: 7, label: "STEP7", title: "本編の核を選択", knowledgeKeys: ["専門ナレッジ 01-06", "悩み素材バンク"] },
  { step: 8, label: "STEP8", title: "ツリー構成決定", knowledgeKeys: ["上書きルール", "投稿構成パターン集"] },
  { step: 9, label: "STEP9", title: "フック作成", knowledgeKeys: ["市場フックパターン集", "バズフックパターン集", "悩み素材バンク", "コアルール", "上書きルール"] },
  { step: 10, label: "STEP10", title: "重複回避チェック", knowledgeKeys: ["ナレッジDB"] },
  { step: 11, label: "STEP11", title: "採点・整合チェック", knowledgeKeys: ["投稿前チェックリスト"] },
  { step: 12, label: "STEP12", title: "Codexファクトチェック", knowledgeKeys: [] },
  { step: 13, label: "STEP13", title: "Claude反映", knowledgeKeys: ["上書きルール", "コアルール", "アカウントコンセプト"] },
  { step: 135, label: "STEP13.5", title: "ユーザー最終確認", knowledgeKeys: [] },
  { step: 14, label: "STEP14", title: "ナレッジ反映", knowledgeKeys: [] },
];
