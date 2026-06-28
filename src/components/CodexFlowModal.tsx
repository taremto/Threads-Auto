"use client";

import { useEffect, useMemo, useState } from "react";
import { getJSON, postJSON } from "@/lib/api";
import { STEP_DEFINITIONS } from "@/lib/generation-steps";
import {
  buildGenerationCountOptions,
  dailyPostCountFromPostingHours,
  generationCountLabel,
  MAX_GENERATE_POSTS,
} from "@/lib/account-posting";

type AiProvider = "claude" | "codex";
type PostLayer = "L1" | "L2" | "L3";

type FlowStep = {
  stepNumber: number;
  status: string;
  summary: string | null;
  knowledgeRefs: string | null;
};

type FlowSession = {
  id: string;
  status: string;
  currentStep: number;
  steps: FlowStep[];
};

type Recommendation = {
  hour: number;
  label: string;
  reason: string;
};

type FlowPostMetadata = {
  layer: PostLayer | "不明";
  angle: string;
  hook: string;
  structure: string;
  knowledgeRefs: string[];
};

type PreviewPost = {
  body: string;
  metadata: FlowPostMetadata;
  recommendation: Recommendation | null;
};

type ApprovalGroup = {
  rootPostId: string;
  postIds: string[];
  index: number;
};

type Props = {
  accountId: string;
  accountName: string;
  postingHours: string;
  onClose: () => void;
  onGenerationStarted: (sessionId: string) => void;
  onReviewReady: () => void;
  onQueued: () => void;
};

type Phase = "setup" | "generating" | "preview" | "queuing";

const LAYER_OPTIONS: Array<{
  value: PostLayer;
  label: string;
}> = [
  { value: "L1", label: "L1 フォロー誘導" },
  { value: "L2", label: "L2 教育" },
  { value: "L3", label: "L3 アフィリエイト" },
];

function defaultLayers(count: number, previous: PostLayer[] = []): PostLayer[] {
  const rotation: PostLayer[] = ["L1", "L2", "L3"];
  return Array.from(
    { length: count },
    (_, index) => previous[index] || rotation[index % rotation.length]
  );
}

function toDateTimeLocalValue(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function buildSchedule(posts: PreviewPost[]): string[] {
  const minimum = Date.now() + 60 * 60 * 1000;
  let previous = 0;
  return posts.map((post, index) => {
    const date = new Date();
    if (
      typeof post.recommendation?.hour === "number" &&
      post.recommendation.hour >= 0 &&
      post.recommendation.hour <= 23
    ) {
      date.setHours(post.recommendation.hour, 0, 0, 0);
    } else {
      date.setHours(date.getHours() + 2 + index * 2);
      date.setMinutes(0, 0, 0);
    }
    while (
      date.getTime() < minimum ||
      (previous > 0 && date.getTime() < previous + 60 * 60 * 1000)
    ) {
      date.setDate(date.getDate() + 1);
    }
    previous = date.getTime();
    return toDateTimeLocalValue(date);
  });
}

function parseKnowledgeRefs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export default function CodexFlowModal({
  accountId,
  accountName,
  postingHours,
  onClose,
  onGenerationStarted,
  onReviewReady,
  onQueued,
}: Props) {
  const dailyCount = dailyPostCountFromPostingHours(postingHours);
  const countOptions = buildGenerationCountOptions(
    dailyCount,
    MAX_GENERATE_POSTS
  );
  const [phase, setPhase] = useState<Phase>("setup");
  const [provider, setProvider] = useState<AiProvider>("codex");
  const [postCount, setPostCount] = useState(dailyCount);
  const [layers, setLayers] = useState<PostLayer[]>(
    defaultLayers(dailyCount)
  );
  const [category, setCategory] = useState("");
  const [instructions, setInstructions] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<FlowSession | null>(null);
  const [previewPosts, setPreviewPosts] = useState<PreviewPost[]>([]);
  const [selectedDateTimes, setSelectedDateTimes] = useState<string[]>([]);
  const [approvedGroups, setApprovedGroups] = useState<ApprovalGroup[]>([]);
  const [queuedRootIds, setQueuedRootIds] = useState<Set<string>>(
    () => new Set()
  );
  const [error, setError] = useState("");

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const fetchSession = async () => {
      try {
        const sessions = await getJSON<FlowSession[]>(
          `/api/generation-flow/sessions?accountId=${encodeURIComponent(accountId)}&limit=20`
        );
        if (cancelled) return;
        const found = sessions.find((item) => item.id === sessionId);
        if (found) setSession(found);
      } catch {
        // 生成リクエスト自体の結果を優先し、進捗取得失敗では止めない。
      }
    };
    fetchSession();
    const timer = window.setInterval(fetchSession, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accountId, sessionId]);

  const currentDefinition = useMemo(
    () =>
      STEP_DEFINITIONS.find(
        (definition) => definition.step === session?.currentStep
      ) || null,
    [session?.currentStep]
  );
  const currentStep = session?.steps.find(
    (step) => step.stepNumber === session.currentStep
  );
  const completedCount =
    session?.steps.filter(
      (step) => step.status === "completed" || step.status === "skipped"
    ).length || 0;
  const progressPercent = Math.min(
    96,
    Math.round((completedCount / STEP_DEFINITIONS.length) * 100)
  );

  function changePostCount(nextCount: number) {
    setPostCount(nextCount);
    setLayers((previous) => defaultLayers(nextCount, previous));
  }

  function changeLayer(index: number, layer: PostLayer) {
    setLayers((previous) =>
      previous.map((item, itemIndex) => (itemIndex === index ? layer : item))
    );
  }

  async function startGeneration() {
    setError("");
    setPhase("generating");
    try {
      const started = await postJSON<{ sessionId: string }>(
        "/api/generation-flow/start",
        {
          accountId,
          layers,
          category: category.trim() || undefined,
        }
      );
      setSessionId(started.sessionId);

      const layerPlan = layers
        .map((layer, index) => `投稿${index + 1}: ${layer}`)
        .join("\n");
      const metadataExamples = layers
        .map(
          (layer, index) =>
            `[[FLOW_META_${index + 1}:{"layer":"${layer}","angle":"切り口名","hook":"使用したフック型","structure":"使用した構造名","knowledgeRefs":["実際に参照したナレッジ名"]}]]`
        )
        .join("\n");
      const flowInstructions = [
        "この生成はWebUIの投稿生成フローです。",
        "最初に .claude/skills/post-generation/SKILL.md を読み、STEP0〜STEP13を順番に実行してください。",
        "STEP2・STEP5などの選択確認はWebUIで委任済みです。追加指定がなければ、おまかせモードで最適な案を選んでください。",
        "Progress Reportingのcurl通知はWebアプリ側が行うため実行しないでください。",
        "STEP13.5のユーザー確認とSTEP14の保存はWebUI側で行います。ファイル保存やDB変更はしないでください。",
        `必ず${postCount}投稿を生成してください。`,
        "全投稿で、悩みの具体場面・感情・結論・フック型・構造・具体アクションを別にしてください。同じ本文の言い換えや同じ退職理由の展開は禁止です。",
        "投稿ごとのLayer指定は次の通りです。順番を変えないでください。",
        layerPlan,
        category.trim()
          ? `共通テーマ指定: ${category.trim()}。ただし投稿ごとに異なる切り口へ分解してください。`
          : "",
        instructions.trim()
          ? `今回の追加指示: ${instructions.trim()}`
          : "",
        "通常の投稿本文をすべて出力したあと、最後に投稿ごとの生成メタ情報を次の形式で1行ずつ出力してください。メタ情報には、実際に使ったフック型、構造名、切り口、参照ナレッジ名を正確に入れてください。",
        metadataExamples,
        "FLOW_META行は投稿本文へ混ぜず、全投稿の末尾にまとめてください。",
      ]
        .filter(Boolean)
        .join("\n");

      const generationRequest = postJSON<{
        previewPosts: PreviewPost[];
      }>("/api/generate", {
        accountId,
        count: postCount,
        provider,
        previewOnly: true,
        flowSessionId: started.sessionId,
        extraInstructions: flowInstructions,
      });
      onGenerationStarted(started.sessionId);
      const generated = await generationRequest;

      setPreviewPosts(generated.previewPosts);
      setSelectedDateTimes(buildSchedule(generated.previewPosts));
      setApprovedGroups([]);
      setQueuedRootIds(new Set());
      setPhase("preview");
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "投稿生成に失敗しました"
      );
      setPhase("setup");
    }
  }

  async function approveAndQueue() {
    if (
      !sessionId ||
      previewPosts.length === 0 ||
      previewPosts.some((post) => !post.body.trim())
    ) {
      return;
    }
    const parsedDates = selectedDateTimes.map((value) => new Date(value));
    if (
      parsedDates.some(
        (date) =>
          !Number.isFinite(date.getTime()) ||
          date.getTime() < Date.now() + 60_000
      )
    ) {
      setError("すべての投稿で、今より1分以上あとの日時を選んでください。");
      return;
    }

    setError("");
    setPhase("queuing");
    const finalPostBody = previewPosts
      .map((post) => post.body.trim())
      .join("\n\n=====\n\n");
    const queued = new Set(queuedRootIds);
    try {
      const groups =
        approvedGroups.length > 0
          ? approvedGroups
          : (
              await postJSON<{ groups: ApprovalGroup[] }>(
                "/api/generation-flow/approve",
                {
                  sessionId,
                  finalPostBody,
                }
              )
            ).groups;
      setApprovedGroups(groups);
      const queueResults: Array<{
        rootPostId: string;
        postIds: string[];
        publishAt: string;
      }> = [];
      for (const group of groups) {
        if (queued.has(group.rootPostId)) continue;
        const publishAt = parsedDates[group.index].toISOString();
        await postJSON("/api/posts/group-action", {
          postId: group.rootPostId,
          action: "queue",
          publishAt,
        });
        queued.add(group.rootPostId);
        setQueuedRootIds(new Set(queued));
        queueResults.push({
          rootPostId: group.rootPostId,
          postIds: group.postIds,
          publishAt,
        });
      }
      await postJSON("/api/generation-flow/progress", {
        sessionId,
        step: 14,
        stepLabel: "STEP14",
        status: "completed",
        summary: `${groups.length}投稿を下書きからキューに追加`,
        output: JSON.stringify({ groups: queueResults }),
        sessionData: { finalPostBody },
      }).catch(() => {});
      onQueued();
    } catch (queueError) {
      const queuedCount = queued.size;
      setError(
        `${
          queueError instanceof Error
            ? queueError.message
            : "キューへの追加に失敗しました"
        }${
          queuedCount > 0
            ? `\n${queuedCount}投稿はキュー追加済みです。残りだけ再試行できます。`
            : ""
        }`
      );
      setPhase("preview");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-gray-800">
              投稿生成フロー
            </h3>
            <p className="mt-1 text-xs text-gray-500">{accountName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={phase === "generating" || phase === "queuing"}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-40"
          >
            閉じる
          </button>
        </div>

        {phase === "setup" && (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-600">
                生成AI
              </label>
              <select
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as AiProvider)
                }
                className="w-full rounded-lg border border-gray-200 px-4 py-2 text-sm"
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-600">
                投稿文生成数
              </label>
              <select
                value={postCount}
                onChange={(event) =>
                  changePostCount(Number(event.target.value))
                }
                className="w-full rounded-lg border border-gray-200 px-4 py-2 text-sm"
              >
                {countOptions.map((count) => (
                  <option key={count} value={count}>
                    {generationCountLabel(count, dailyCount)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-2 text-sm font-medium text-gray-600">
                投稿ごとのLayer
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {layers.map((layer, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
                  >
                    <span className="w-14 shrink-0 text-xs font-medium text-gray-500">
                      投稿{index + 1}
                    </span>
                    <select
                      value={layer}
                      onChange={(event) =>
                        changeLayer(index, event.target.value as PostLayer)
                      }
                      className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs"
                    >
                      {LAYER_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-600">
                共通の悩み・テーマ（任意）
              </label>
              <input
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="例：短期離職の退職理由、上司の顔色に疲れた"
                className="w-full rounded-lg border border-gray-200 px-4 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-600">
                追加指示（任意）
              </label>
              <textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                rows={3}
                placeholder="今回だけ反映したい切り口や体験を入力"
                className="w-full rounded-lg border border-gray-200 px-4 py-3 text-sm"
              />
            </div>
            <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-relaxed text-blue-700">
              指定数すべてを別の切り口で生成します。似た投稿が混ざった場合は承認画面へ進めず、再生成を案内します。
            </div>
            <button
              type="button"
              onClick={startGeneration}
              className="w-full rounded-lg px-5 py-2.5 text-sm font-medium text-white"
              style={{ background: "var(--accent)" }}
            >
              生成開始
            </button>
          </div>
        )}

        {phase === "generating" && (
          <div className="py-5">
            <div className="mb-3 flex items-center justify-between text-sm">
              <span className="font-medium text-gray-700">
                {currentDefinition
                  ? `${currentDefinition.label} ${currentDefinition.title}`
                  : "生成フローを準備中"}
              </span>
              <span className="text-xs text-blue-500">
                {provider === "claude" ? "Claude" : "Codex"}作業中
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-blue-100">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-500"
                style={{ width: `${Math.max(6, progressPercent)}%` }}
              />
            </div>
            {currentStep?.summary && (
              <p className="mt-3 text-sm text-gray-600">
                {currentStep.summary}
              </p>
            )}
            {currentStep && (
              <div className="mt-3 flex flex-wrap gap-1">
                {parseKnowledgeRefs(currentStep.knowledgeRefs).map((title) => (
                  <span
                    key={title}
                    className="rounded-full bg-purple-50 px-2 py-0.5 text-[11px] text-purple-600"
                  >
                    {title}
                  </span>
                ))}
              </div>
            )}
            <p className="mt-5 text-xs text-gray-400">
              生成数が多いほど時間がかかります。この画面を閉じずにお待ちください。
            </p>
          </div>
        )}

        {(phase === "preview" || phase === "queuing") && (
          <div>
            <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              {previewPosts.length}投稿の生成が完了しました。生成フローの「ユーザー最終確認」で、投稿ごとに承認・否認・修正できます。
            </div>
            <div className="space-y-5">
              {previewPosts.map((post, index) => {
                const approvedGroup = approvedGroups.find(
                  (group) => group.index === index
                );
                const queued =
                  !!approvedGroup &&
                  queuedRootIds.has(approvedGroup.rootPostId);
                return (
                  <section
                    key={index}
                    className="rounded-xl border border-gray-200 p-4"
                  >
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="font-bold text-gray-800">
                        投稿{index + 1}
                      </span>
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600">
                        {post.metadata.layer}
                      </span>
                      {queued && (
                        <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-600">
                          キュー追加済み
                        </span>
                      )}
                    </div>
                    <div className="mb-3 grid gap-2 rounded-lg bg-gray-50 p-3 text-xs text-gray-600 sm:grid-cols-3">
                      <div>
                        <span className="font-medium text-gray-700">
                          切り口：
                        </span>
                        {post.metadata.angle || "生成AIが選択"}
                      </div>
                      <div>
                        <span className="font-medium text-gray-700">
                          フック：
                        </span>
                        {post.metadata.hook || "生成AIが選択"}
                      </div>
                      <div>
                        <span className="font-medium text-gray-700">
                          構造：
                        </span>
                        {post.metadata.structure || "生成AIが選択"}
                      </div>
                    </div>
                    <div className="mb-3 flex flex-wrap gap-1">
                      {post.metadata.knowledgeRefs.length > 0 ? (
                        post.metadata.knowledgeRefs.map((title) => (
                          <span
                            key={title}
                            className="rounded-full bg-purple-50 px-2 py-0.5 text-[11px] text-purple-600"
                          >
                            {title}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-gray-400">
                          参照ナレッジは生成フロー詳細で確認できます
                        </span>
                      )}
                    </div>
                    <textarea
                      value={post.body}
                      readOnly
                      rows={12}
                      className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-relaxed"
                    />
                    {approvedGroups.length > 0 && (
                    <div className="mt-3">
                      <label className="mb-1 block text-xs font-medium text-gray-600">
                        予約日時
                      </label>
                      <input
                        type="datetime-local"
                        value={selectedDateTimes[index] || ""}
                        onChange={(event) =>
                          setSelectedDateTimes((previous) =>
                            previous.map((value, itemIndex) =>
                              itemIndex === index
                                ? event.target.value
                                : value
                            )
                          )
                        }
                        disabled={phase === "queuing" || queued}
                        className="w-full rounded-lg border border-gray-200 px-4 py-2 text-sm"
                      />
                      {post.recommendation && (
                        <p className="mt-1 text-xs text-blue-600">
                          推奨 {post.recommendation.label}：
                          {post.recommendation.reason}
                        </p>
                      )}
                    </div>
                    )}
                  </section>
                );
              })}
            </div>
            <button
              type="button"
              onClick={onReviewReady}
              disabled={phase === "queuing"}
              className="mt-5 w-full rounded-lg border border-purple-200 bg-purple-50 px-5 py-2.5 text-sm font-medium text-purple-700 disabled:opacity-50"
            >
              生成フローで1投稿ずつ確認
            </button>
            {approvedGroups.length > 0 && (
              <button
                type="button"
                onClick={approveAndQueue}
                disabled={
                  phase === "queuing" ||
                  previewPosts.some((post) => !post.body.trim())
                }
                className="mt-3 w-full rounded-lg bg-orange-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
              >
                {phase === "queuing"
                  ? "キューに追加中…"
                  : `${previewPosts.length}投稿を下書きからキューに追加`}
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="mt-4 whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
