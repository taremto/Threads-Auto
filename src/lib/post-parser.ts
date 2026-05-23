/**
 * 生成テキスト / インポートテキストを「スレッド（グループ）× 投稿アイテム」に分解する。
 *
 * 想定フォーマット:
 *   ■1 ... ■2 ...
 *   =====
 *   ■1 ... ■2 ...
 *
 * ただしAI（特にOpus）が ===== を出さなかったり、見出し形式（「投稿1:」「## スレッド2」）で
 * 区切ったり、マークダウン箇条書きにしたりと崩れることがあるため、多段フォールバックで吸収する。
 * どうしても分割できない場合は、段落（空行区切り）単位でばらして単体下書きにする
 * （= 1枠にダラダラ固まる事故を防ぐ。ユーザーは下書きで確認・編集できる）。
 */

export type ParsedPost = {
  thread: boolean;
  items: string[];
};

export function parsePosts(rawText: string, expectedCount = 1): ParsedPost[] {
  const text = normalizeOutput(rawText);
  if (!text) return [];

  // Stage 1: テキスト全体を「スレッド（グループ）」に分割
  const threadChunks = splitIntoThreads(text);

  // Stage 2: 各スレッドを ■1 ■2 ... の投稿アイテムに分割
  let posts: ParsedPost[] = [];
  for (const chunk of threadChunks) {
    const items = splitThreadItems(chunk);
    if (items.length === 0) continue;
    posts.push({ thread: items.length > 1, items });
  }

  // Stage 3: 期待本数に全然届かない（=フォーマット崩壊で1〜2枠に固まった）場合のフォールバック。
  if (expectedCount >= 2 && posts.length < Math.ceil(expectedCount / 2)) {
    const fallback = looseSplit(text);
    if (fallback.length > posts.length) {
      console.warn(
        `[post-parser] フォーマット崩れを検出: 期待${expectedCount}本に対しパース結果${posts.length}件 → 段落フォールバックで${fallback.length}件に分割`
      );
      posts = fallback;
    }
  }

  return posts.filter((p) => p.items.some((i) => i.trim().length > 0));
}

const CODE_FENCE_LINE_RE = /^[ \t　]*`{3,}[a-zA-Z0-9_-]*[ \t　]*$/;

function normalizeOutput(text: string): string {
  let t = (text || "").trim();
  // コードフェンス（```）の行はどこにあっても除去（Threads本文にフェンスは出てこない前提）
  t = t
    .split("\n")
    .filter((l) => !CODE_FENCE_LINE_RE.test(l))
    .join("\n")
    .trim();
  // 先頭の前置き行（「承知しました」「以下に〜」等）を投稿本文が始まるまで除去
  const lines = t.split("\n");
  const preambleRe =
    /^(承知しました|了解(?:です|しました)?|わかりました|かしこまりました|はい[、。]?$|では[、。]?$|それでは[、。]?$|お待たせ.*$|ご要望.*$|以下.*(?:生成|出力|作成|示し|提示)(?:します|しました|いたします)[。：:]?.*$|ここから.*$|では[、。].*(?:生成|出力)します.*$|生成しました[。：:]?$)/;
  while (lines.length > 0) {
    const first = (lines[0] || "").trim();
    if (first === "" || preambleRe.test(first)) {
      lines.shift();
    } else {
      break;
    }
  }
  return lines.join("\n").trim();
}

const SEPARATOR_LINE_RE =
  /^[ \t　]*(?:={3,}|={1,}\s*={1,}\s*={1,}|-{3,}|–{3,}|—{2,}|\*{3,}|_{3,}|―{2,}|─{2,}|━{2,}|＝{3,}|•{3,}|・{3,})[ \t　]*$/;

// 「投稿1:」「【スレッド2】」「## ツリー投稿3」「1本目」など、スレッド見出し行
const THREAD_HEADER_RE =
  /^[ \t　]*(?:[#＃]{1,4}[ \t　]*)?(?:\*{1,2})?[【\[（(]?[ \t　]*(?:投稿|スレッド|ツリー(?:投稿)?|ポスト|つぶやき|Thread|Post|POST)[ \t　]*(?:[#＃№]|No\.?|その)?[ \t　]*\d+[ \t　]*(?:本目|個目)?[ \t　]*[】\]）)]?(?:\*{1,2})?[ \t　]*[:：・.。、）)]?[ \t　]*$/i;
const NUMBERED_HEADER_RE =
  /^[ \t　]*\d+[ \t　]*(?:本目|個目|つ目)[ \t　]*[:：・.。、）)]?[ \t　]*$/;

// スレッド内の投稿アイテム先頭マーカー（行頭）: ■1 / ▼2 / ① / (1/3)
const ITEM_MARKER_LINE_RE =
  /^[ \t　]*(?:[■▼◇◆▶▷●○◯□▪▫]\s*(?:\d+|CTA|cta)|[（(]?\d+\s*[\/／]\s*\d+[）)]?|[①②③④⑤⑥⑦⑧⑨⑩])[ \t　]*[:：・.。、）)]?[ \t　]*/;
// 行頭の「■1」相当（スレッド境界検出用）
const ITEM_MARKER_ONE_RE = /^[ \t　]*[■▼◇◆▶▷●○◯□▪▫]\s*1\b/;

function splitIntoThreads(text: string): string[] {
  const lines = text.split("\n");

  // 1) 区切り線（=====, -----, ―― など）で分割
  if (lines.some((l) => SEPARATOR_LINE_RE.test(l))) {
    const chunks: string[] = [];
    let cur: string[] = [];
    for (const l of lines) {
      if (SEPARATOR_LINE_RE.test(l)) {
        const joined = cur.join("\n").trim();
        if (joined) chunks.push(joined);
        cur = [];
      } else {
        cur.push(l);
      }
    }
    const tail = cur.join("\n").trim();
    if (tail) chunks.push(tail);
    if (chunks.length > 1) return chunks;
  }

  // 2) スレッド見出し行（「投稿1」「【スレッド2】」「## ツリー投稿3」「1本目」）で分割
  const headerIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (THREAD_HEADER_RE.test(lines[i]) || NUMBERED_HEADER_RE.test(lines[i])) {
      headerIdx.push(i);
    }
  }
  if (headerIdx.length > 1) {
    const chunks: string[] = [];
    for (let k = 0; k < headerIdx.length; k++) {
      const start = headerIdx[k] + 1;
      const end = k + 1 < headerIdx.length ? headerIdx[k + 1] : lines.length;
      const chunk = lines.slice(start, end).join("\n").trim();
      if (chunk) chunks.push(chunk);
    }
    if (chunks.length > 1) return chunks;
  }

  // 3) 「■1」が複数回出てくる → 各「■1」を新しいスレッドの開始とみなす
  const oneStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ITEM_MARKER_ONE_RE.test(lines[i])) oneStarts.push(i);
  }
  if (oneStarts.length > 1) {
    const chunks: string[] = [];
    for (let k = 0; k < oneStarts.length; k++) {
      const start = oneStarts[k];
      const end = k + 1 < oneStarts.length ? oneStarts[k + 1] : lines.length;
      const chunk = lines.slice(start, end).join("\n").trim();
      if (chunk) chunks.push(chunk);
    }
    if (chunks.length > 1) return chunks;
  }

  // 4) 区切りが見つからない → 全体で1スレッド
  return [text.trim()];
}

function splitThreadItems(chunk: string): string[] {
  let c = chunk.trim();
  if (!c) return [];
  // 先頭の [投稿] / [post] 等の短いラベルを除去
  c = c.replace(/^[【\[（(][^】\]）)]{1,12}[】\]）)][ \t　]*\n?/, "").trim();

  const lines = c.split("\n");

  // 行頭マーカー（■1 / ① / 1/3 など）で分割
  const markerIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ITEM_MARKER_LINE_RE.test(lines[i])) markerIdx.push(i);
  }
  if (markerIdx.length >= 1) {
    const items: string[] = [];
    const head = lines.slice(0, markerIdx[0]).join("\n").trim();
    if (head && markerIdx[0] > 0) items.push(head);
    for (let k = 0; k < markerIdx.length; k++) {
      const startLine = lines[markerIdx[k]].replace(ITEM_MARKER_LINE_RE, "");
      const restStart = markerIdx[k] + 1;
      const restEnd = k + 1 < markerIdx.length ? markerIdx[k + 1] : lines.length;
      const rest = lines.slice(restStart, restEnd).join("\n");
      const item = [startLine, rest].join("\n").trim();
      if (item) items.push(item);
    }
    const filtered = items.filter(Boolean);
    if (filtered.length >= 1) return filtered;
  }

  // マーカーが行中（行頭でない）にある場合 — 「■1」「■2」を文中で使っているケース
  const inlineSplit = c
    .split(/(?:^|[\s。、])[■▼◇◆▶▷]\s*(?:\d+|CTA|cta)[ 　:：.、]*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (inlineSplit.length > 1) return inlineSplit;

  // どれも無い → 単体投稿として1件
  return [c];
}

// フォーマット完全崩壊時のフォールバック: 段落（空行区切り）でばらして単体下書きに
function looseSplit(text: string): ParsedPost[] {
  const paras = text
    .split(/\n[ \t　]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p && !SEPARATOR_LINE_RE.test(p) && !THREAD_HEADER_RE.test(p))
    .map((p) => p.replace(ITEM_MARKER_LINE_RE, "").trim())
    .filter(Boolean);
  if (paras.length < 2) return [];
  return paras.map((p) => ({ thread: false, items: [p] }));
}
