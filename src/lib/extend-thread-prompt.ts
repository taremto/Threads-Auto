/**
 * extend-thread-prompt.ts — 既存の下書きツリーに「続きの1投稿」をAI生成させる
 * プロンプトを組み立てる純関数（DB非依存・テスト対象）。
 *
 * 本生成 generate/route.ts の buildPrompt の声・品質・表現制約の要点を流用しつつ、
 * 「次の1投稿だけ・本文のみ」を出させてパースを単純化する（■マーカー/区切り線なし）。
 */
export type ExtendThreadPromptInput = {
  conceptSheet: string;
  personaSheet?: string;
  rules: string;
  structures: string;
  customKnowledges: string[];
  existingItems: string[]; // 既存ツリーの本文（sortOrder昇順）
};

export function buildExtendThreadPrompt(input: ExtendThreadPromptInput): string {
  const {
    conceptSheet,
    personaSheet,
    rules,
    structures,
    customKnowledges,
    existingItems,
  } = input;

  const parts: string[] = [
    "あなたはSNSコンテンツの専門家です。以下のアカウントコンセプト・ペルソナ設計・ルール・構成パターンに沿って、既存のThreadsツリー（連続投稿）に自然につながる『次の1投稿』だけを書いてください。",
    "",
    "## アカウントコンセプト",
    conceptSheet,
    "",
  ];

  if (personaSheet) {
    parts.push("## ペルソナ設計", personaSheet, "");
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

  parts.push(
    "## これまでのツリー（この流れの続きを書く）",
    ...existingItems.map((t, i) => `■${i + 1}\n${t}`),
    "",
    "## 品質基準（妥協禁止）",
    "- 前の投稿の話題・語り口・テンションを引き継ぎ、同じ人物が続けて書いた1投稿にする",
    "- 直前の投稿の終わり方を受けて自然に展開する（唐突な新ネタ・総集編的な要約をしない）",
    "- 既出の言い回し・結論をそのまま繰り返さない。一歩踏み込む／具体例や実感を足す",
    "- AI感のある表現禁止: **太字**、【見出し】、箇条書き連発、過度に整った論理展開",
    "- ですます調とタメ口の混在で生っぽさを出す。接続詞は口語化（『また』→『あと』等）",
    "",
    "## 出力フォーマット（絶対厳守）",
    "- **続きの1投稿の本文だけ**を出力する（追加できるのは1投稿のみ）",
    "- 200〜500字",
    "- 前置き・あいさつ・説明・採点・コードブロック（```）・見出し・『■1』などのマーカー・『=====』などの区切り線は一切出力しない",
    "- マークダウン記法（**太字**、## 見出し、- や 1. の箇条書き、表）を使わない",
    "- 本文のテキストのみを、そのまま投稿できる形で出力する"
  );

  return parts.join("\n");
}

export type RewriteThreadPromptInput = ExtendThreadPromptInput & {
  targetCount: number; // 作り直し後の投稿数（既存n + 1）
};

// 既存ツリーを「同じテーマ・主張のまま、自然な流れの targetCount 投稿のツリーに全文リライト」する
// プロンプト。出力は1ツリーぶんの ■1〜■{targetCount}（parsePosts が複数アイテムとして読める形）。
export function buildRewriteThreadPrompt(input: RewriteThreadPromptInput): string {
  const {
    conceptSheet,
    personaSheet,
    rules,
    structures,
    customKnowledges,
    existingItems,
    targetCount,
  } = input;
  const n = Math.max(2, Math.floor(targetCount));

  const parts: string[] = [
    `あなたはSNSコンテンツの専門家です。以下のアカウントコンセプト・ペルソナ設計・ルール・構成パターンに沿って、既存のThreadsツリー（連続投稿）を、同じテーマ・主張・語り口のまま、より自然な流れの「ちょうど${n}投稿のツリー」に作り直してください。`,
    "",
    "## アカウントコンセプト",
    conceptSheet,
    "",
  ];

  if (personaSheet) {
    parts.push("## ペルソナ設計", personaSheet, "");
  }

  if (rules) parts.push("## 投稿生成ルール", rules, "");
  if (structures) parts.push("## 投稿構成パターン集", structures, "");
  for (const custom of customKnowledges) parts.push("## 追加ナレッジ", custom, "");

  parts.push(
    "## 元のツリー（このテーマ・主張を保ったまま作り直す）",
    ...existingItems.map((t, i) => `■${i + 1}\n${t}`),
    "",
    "## リライト方針（妥協禁止）",
    `- 元の主張・テーマ・結論はブレさせない。語り口・テンションも同じ人物のまま${n}投稿に再構成する`,
    "- 単に元を薄めて引き伸ばさない。情報を足す/具体例・実感を入れる/論の流れを整理して密度を上げる",
    `- 構成は フック(■1) → 展開 → ${n >= 3 ? "深掘り → " : ""}締め の自然な流れにする（投稿をまたいで話が前のめりに続く）`,
    "- 既出の言い回し・同じ語尾の連続を避ける。AI感のある表現禁止（**太字**、【見出し】、箇条書き連発、過度に整った論理展開）",
    "- ですます調とタメ口の混在で生っぽさを出す。接続詞は口語化（『また』→『あと』等）",
    "",
    "## 出力フォーマット（絶対厳守）",
    `- **ちょうど${n}投稿**を、行頭 ■1 〜 ■${n} で出力する（■マーカーは必ず${n}個）`,
    "- 各投稿は200〜500字",
    "- 前置き・あいさつ・説明・採点・コードブロック（```）・見出し・『=====』などの区切り線は一切出力しない",
    "- マークダウン記法（**太字**、## 見出し、- や 1. の箇条書き、表）を使わない",
    "- ■マーカーと本文だけを、そのまま投稿できる形で出力する"
  );

  return parts.join("\n");
}
