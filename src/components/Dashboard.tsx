"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Sidebar from "./Sidebar";
import PostCard from "./PostCard";
import AddAccountModal from "./AddAccountModal";
import OverviewPage from "./OverviewPage";
import AnalyticsPage from "./AnalyticsPage";
import CompetitorAnalysisPage from "./CompetitorAnalysisPage";
import SettingsPage from "./SettingsPage";
import GenerateModal from "./GenerateModal";
import GenerationFlowPage from "./GenerationFlowPage";
import CodexFlowModal from "./CodexFlowModal";
import KnowledgeSuggestionReview from "./KnowledgeSuggestionReview";
import type { AppliedAiInstruction } from "./PostCard";

type Tab = "draft" | "queued" | "posted" | "error";
type Page =
  | "posts"
  | "overview"
  | "analytics"
  | "competitor"
  | "settings"
  | "knowledge"
  | "generation-flow";

type Post = {
  id: string;
  groupNo: number;
  sortOrder: number;
  body: string;
  postType: string;
  charCount: number;
  score: number | null;
  recommendedHour: number | null;
  recommendedLabel: string | null;
  recommendedReason: string | null;
  scheduledDate: string | null;
  scheduledHour: number | null;
  scheduledMin: number | null;
  publishAt: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  media?: { id: string; publicUrl: string; sortOrder: number; status: string }[];
};

const statusMap: Record<Tab, string> = {
  draft: "draft",
  queued: "queued",
  posted: "posted",
  error: "error",
};

const tabLabel: Record<Tab, string> = {
  draft: "下書き",
  queued: "キュー",
  posted: "投稿済み",
  error: "エラー",
};

type AccountLite = {
  id: string;
  name: string;
  postingHours: string;
  cloudOffloadEnabled: boolean;
};

export default function Dashboard() {
  const [activePage, setActivePage] = useState<Page>("posts");
  const [activeTab, setActiveTab] = useState<Tab>("draft");
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountLite[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showCodexFlow, setShowCodexFlow] = useState(false);
  const [accountVersion, setAccountVersion] = useState(0);
  const [suggestionVersion, setSuggestionVersion] = useState(0);
  const [hasAccounts, setHasAccounts] = useState<boolean | null>(null);
  const postsRequestSeq = useRef(0);

  const activeAccount = accounts.find((a) => a.id === activeAccountId) || null;

  const clearPostList = useCallback(() => {
    postsRequestSeq.current++;
    setPosts([]);
  }, []);

  const fetchPosts = useCallback(async (options?: { accountId?: string; tab?: Tab }) => {
    const accountId = options?.accountId ?? activeAccountId;
    const tab = options?.tab ?? activeTab;
    const requestSeq = ++postsRequestSeq.current;

    if (!accountId) {
      queueMicrotask(() => {
        if (requestSeq === postsRequestSeq.current) setPosts([]);
      });
      return;
    }

    if (requestSeq === postsRequestSeq.current) setLoading(true);
    try {
      const params = new URLSearchParams({
        accountId,
        status: statusMap[tab],
        t: String(Date.now()),
      });
      const r = await fetch(`/api/posts?${params.toString()}`, {
        cache: "no-store",
      });
      const nextPosts = r.ok ? await r.json() : [];
      if (requestSeq === postsRequestSeq.current) setPosts(nextPosts);
    } catch {
      if (requestSeq === postsRequestSeq.current) setPosts([]);
    } finally {
      if (requestSeq === postsRequestSeq.current) setLoading(false);
    }
  }, [activeAccountId, activeTab]);

  useEffect(() => {
    if (activePage !== "posts") return;
    const initialId = window.setTimeout(() => fetchPosts(), 0);
    const intervalMs = activeTab === "draft" ? 60_000 : 15_000;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") fetchPosts();
    }, intervalMs);
    return () => {
      window.clearTimeout(initialId);
      window.clearInterval(id);
    };
  }, [fetchPosts, activePage, activeTab]);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => {
        if (!r.ok) return [];
        return r.json();
      })
      .then((list: AccountLite[]) => {
        setAccounts(list);
        setHasAccounts(list.length > 0);
        if (list.length > 0 && !activeAccountId) {
          setActiveAccountId(list[0].id);
        }
      })
      .catch(() => setHasAccounts(false));
  }, [activeAccountId, accountVersion]);

  // 軽量なアカウント一覧の取り直し（自動選択ロジックは触らない）
  const refetchAccountsLite = useCallback(() => {
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (Array.isArray(list)) {
          setAccounts(list);
          if (list.length > 0) setHasAccounts(true);
        }
      })
      .catch(() => {});
  }, []);

  // ターミナルでのセットアップ（クラウドオフロード等）の結果を、開いている画面に自動反映する。
  // タブに戻ってきた時はアカウント一覧＋投稿一覧を、表示中は10秒おきにアカウント一覧を取り直す。
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      refetchAccountsLite();
      if (activePage === "posts") fetchPosts();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refetchAccountsLite();
    }, 10000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(id);
    };
  }, [refetchAccountsLite, fetchPosts, activePage]);

  async function queuePost(postId: string, publishAt: string) {
    try {
      const res = await fetch("/api/posts/group-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, action: "queue", publishAt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        alert(
          `キューに追加できませんでした。\n${data?.error || `エラー (HTTP ${res.status})`}\n\nもう一度お試しください。`
        );
        fetchPosts();
        return;
      }
      // 成功 → キュータブに切り替えて、ちゃんと入ったのを見せる
      setActiveTab("queued");
      fetchPosts({ tab: "queued" });
    } catch (e) {
      alert(`キューに追加できませんでした。\n${String(e)}\n\nもう一度お試しください。`);
      fetchPosts();
    }
  }

  async function reschedulePost(postId: string, publishAt: string) {
    try {
      const res = await fetch("/api/posts/group-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, action: "reschedule", publishAt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        alert(
          `予約時刻を変更できませんでした。\n${data?.error || `エラー (HTTP ${res.status})`}\n\nもう一度お試しください。`
        );
        fetchPosts();
        return;
      }
      fetchPosts();
    } catch (e) {
      alert(`予約時刻を変更できませんでした。\n${String(e)}\n\nもう一度お試しください。`);
      fetchPosts();
    }
  }

  async function updatePostStatus(postId: string, status: string) {
    const res = await fetch("/api/posts/group-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId, action: "status", status }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      alert(`変更できませんでした。\n${data?.error || `エラー (HTTP ${res.status})`}`);
    }
    fetchPosts();
  }

  async function retryFailedPost(postId: string) {
    try {
      const res = await fetch("/api/posts/group-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, action: "retryFailed" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        alert(
          `再試行の予約ができませんでした。\n${data?.error || `エラー (HTTP ${res.status})`}\n\n原因が分からない場合は、自動投稿チェックのサポート用レポートを送ってください。`
        );
        fetchPosts();
        return;
      }
      setActiveTab("queued");
      fetchPosts({ tab: "queued" });
    } catch (e) {
      alert(`再試行の予約ができませんでした。\n${String(e)}`);
      fetchPosts();
    }
  }

  async function failedToDraft(postId: string) {
    try {
      const res = await fetch("/api/posts/group-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, action: "failedToDraft" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        alert(`下書きに戻せませんでした。\n${data?.error || `エラー (HTTP ${res.status})`}`);
        fetchPosts();
        return;
      }
      setActiveTab("draft");
      fetchPosts({ tab: "draft" });
    } catch (e) {
      alert(`下書きに戻せませんでした。\n${String(e)}`);
      fetchPosts();
    }
  }

  async function deletePost(postId: string) {
    await fetch("/api/posts/group-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId, action: "delete" }),
    });
    fetchPosts();
  }

  async function editPost(
    postId: string,
    body: string,
    revisionInstructions: AppliedAiInstruction[] = []
  ) {
    const response = await fetch("/api/posts/group-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postId,
        action: "edit",
        body,
        revisionInstructions,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.error) {
      throw new Error(data?.error || `投稿を保存できませんでした (HTTP ${response.status})`);
    }
    fetchPosts();
  }

  // ツリーをAIで拡張（下書きのみ）。append=続き1投稿追加 / rewrite=全文リライトで+1
  async function extendThread(
    postId: string,
    mode: "append" | "rewrite" = "append"
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch("/api/posts/extend-thread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && !data?.error) {
        fetchPosts();
        return { ok: true };
      }
      return { ok: false, error: data?.error || `エラー (HTTP ${res.status})` };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function bulkQueueAll() {
    if (!activeAccountId) return;

    // dryRunで割当プレビュー取得
    const previewRes = await fetch("/api/posts/bulk-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: activeAccountId, dryRun: true }),
    });
    const preview = await previewRes.json();

    if (preview.error) {
      alert(`エラー: ${preview.error}`);
      return;
    }
    if (preview.count === 0) {
      alert("下書きがありません");
      return;
    }

    const fmt = (iso: string) => {
      const d = new Date(iso);
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    };
    const list = preview.assignments
      .map(
        (a: {
          groupNo: number;
          publishAt: string;
          preview: string;
          recommendedLabel?: string | null;
        }) =>
          `  ${fmt(a.publishAt)}  #${a.groupNo}  ${a.preview}…${
            a.recommendedLabel ? `（推奨: ${a.recommendedLabel}）` : ""
          }`
      )
      .join("\n");

    const ok = window.confirm(
      `下書き ${preview.count} 件（${preview.groups} グループ）を以下の時刻でキューに追加します。\n\n${list}\n\n実行しますか？`
    );
    if (!ok) return;

    const res = await fetch("/api/posts/bulk-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: activeAccountId }),
    });
    const data = await res.json();
    if (data.error) {
      alert(`エラー: ${data.error}`);
      return;
    }
    setActiveTab("queued");
    fetchPosts({ tab: "queued" });
  }

  function handleAccountCreated(accountId: string) {
    setShowAddAccount(false);
    setActiveAccountId(accountId);
    setActiveTab("draft");
    setActivePage("posts");
    setAccountVersion((v) => v + 1);
  }

  if (hasAccounts === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-gray-400">読み込み中...</p>
      </div>
    );
  }

  if (hasAccounts === false) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-gray-800 mb-2">
            Threads Auto
          </h1>
          <p className="text-gray-500 mb-8">
            Threads投稿の管理・予約投稿を一元化するツールです。
            <br />
            まずはアカウントを追加して始めましょう。
          </p>
          <button
            onClick={() => setShowAddAccount(true)}
            className="px-8 py-3 rounded-xl text-sm font-medium text-white shadow-lg hover:shadow-xl transition-shadow"
            style={{ background: "var(--accent)" }}
          >
            アカウントを追加して始める
          </button>
        </div>

        {showAddAccount && (
          <AddAccountModal
            onClose={() => setShowAddAccount(false)}
            onCreated={handleAccountCreated}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-x-auto">
      <Sidebar
        activePage={activePage}
        onPageChange={setActivePage}
        activeTab={activeTab}
        onTabChange={(tab) => {
          clearPostList();
          setActiveTab(tab);
          // 投稿ステータスのタブ（下書き/キュー/投稿済み/エラー）を押したら
          // 分析や競合分析などのページに居ても投稿一覧へ戻す
          setActivePage("posts");
        }}
        activeAccountId={activeAccountId}
        onAccountChange={(accountId) => {
          clearPostList();
          setActiveAccountId(accountId);
          setActiveTab("draft");
        }}
        onAddAccount={() => setShowAddAccount(true)}
        accountVersion={accountVersion}
      />

      {activePage === "overview" && (
        <OverviewPage
          onNavigate={(accountId, tab) => {
            clearPostList();
            setActiveAccountId(accountId);
            setActiveTab(tab);
            setActivePage("posts");
          }}
        />
      )}
      {activePage === "analytics" && (
        <AnalyticsPage
          accountId={activeAccountId}
          accounts={accounts}
          onAccountChange={(id) => setActiveAccountId(id)}
        />
      )}
      {activePage === "competitor" && (
        <CompetitorAnalysisPage accounts={accounts} />
      )}
      {activePage === "generation-flow" && (
        <GenerationFlowPage accountId={activeAccountId} />
      )}
      {activePage === "settings" && <SettingsPage mode="accounts" />}
      {activePage === "knowledge" && <SettingsPage mode="knowledge" />}
      {activePage === "posts" && (
        <main className="min-w-[640px] flex-1 overflow-y-auto">
          {/* Top bar */}
          <div className="flex items-center justify-between px-8 pt-6 pb-4">
            <div>
              <h2 className="text-xl font-bold text-gray-800">
                {tabLabel[activeTab]} ({posts.length})
              </h2>
              {activeAccount && (
                <p className="text-xs text-gray-400 mt-0.5">
                  アカウント: <span className="font-medium text-gray-500">{activeAccount.name}</span>
                  {activeAccount.cloudOffloadEnabled && (
                    <span className="ml-2 text-green-600">☁ クラウドオフロードON</span>
                  )}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              {activeTab === "draft" && posts.length > 0 && (
                <button
                  onClick={bulkQueueAll}
                  className="px-5 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-80"
                  style={{ background: "#ff9800" }}
                  title="下書き全件を投稿時間帯に沿って自動でキューに追加"
                >
                  全件キューに追加
                </button>
              )}
              {activeTab === "draft" && (
                <button
                  onClick={() => setShowGenerate(true)}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200"
                >
                  通常AI生成
                </button>
              )}
              {activeTab === "draft" && activeAccountId && (
                <button
                  onClick={() => setShowCodexFlow(true)}
                  className="px-5 py-2 rounded-lg text-sm font-medium text-white"
                  style={{ background: "var(--accent)" }}
                >
                  生成開始
                </button>
              )}
            </div>
          </div>

          {/* Posts */}
          <div className="px-8 pb-8">
            {activeTab === "draft" && activeAccountId && (
              <KnowledgeSuggestionReview
                accountId={activeAccountId}
                refreshKey={suggestionVersion}
              />
            )}
            {activeTab === "queued" &&
              posts.length > 0 &&
              activeAccount &&
              !activeAccount.cloudOffloadEnabled && (
                <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800 leading-relaxed">
                  ⚠️ <b>このPCがスリープ／電源オフの間は、予約時刻になっても投稿されません。</b>
                  キューの投稿はこのアプリ（PC）が起動している時だけ実行されます。
                  PCを閉じていても投稿させたい場合は「設定 → アカウント編集 → ☁ クラウドオフロード」をセットアップしてください。
                </div>
              )}
            {activeAccountId && loading && posts.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                <svg
                  className="animate-spin mb-3"
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeOpacity="0.2"
                  />
                  <path
                    d="M22 12a10 10 0 0 1-10 10"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
                <p className="text-sm">読み込み中…</p>
              </div>
            )}
            {activeAccountId && !loading && posts.length === 0 && (
              <div className="text-center py-20 text-gray-400">
                <p className="text-lg mb-2">
                  {tabLabel[activeTab]}はまだありません
                </p>
                {activeTab === "draft" && (
                  <p className="text-sm">
                    「生成開始」でCodex投稿生成フローを始めるか、
                    「通常AI生成」で一括生成できます
                  </p>
                )}
              </div>
            )}

            {posts.map((post, i) => {
              const isFirstInGroup =
                i === 0 || posts[i - 1].groupNo !== post.groupNo;
              const groupPosts = posts.filter(
                (p) => p.groupNo === post.groupNo
              );
              return (
                <PostCard
                  key={post.id}
                  post={post}
                  showActions={isFirstInGroup}
                  groupPosts={groupPosts}
                  cloudOffloadEnabled={activeAccount?.cloudOffloadEnabled ?? false}
                  onQueue={queuePost}
                  onReschedule={reschedulePost}
                  onBackToDraft={(id) => updatePostStatus(id, "draft")}
                  onRetryFailed={retryFailedPost}
                  onFailedToDraft={failedToDraft}
                  onDelete={deletePost}
                  onEdit={editPost}
                  onKnowledgeSuggestionCreated={() =>
                    setSuggestionVersion((version) => version + 1)
                  }
                  onExtendThread={extendThread}
                />
              );
            })}
          </div>
        </main>
      )}

      {showAddAccount && (
        <AddAccountModal
          onClose={() => setShowAddAccount(false)}
          onCreated={handleAccountCreated}
        />
      )}

      {showGenerate && (
        <GenerateModal
          currentAccountId={activeAccountId}
          onClose={() => setShowGenerate(false)}
          onGenerated={() => {
            setShowGenerate(false);
            setActiveTab("draft");
            fetchPosts();
          }}
        />
      )}

      {showCodexFlow && activeAccountId && activeAccount && (
        <CodexFlowModal
          accountId={activeAccountId}
          accountName={activeAccount.name}
          postingHours={activeAccount.postingHours}
          onClose={() => setShowCodexFlow(false)}
          onGenerationStarted={() => {
            setShowCodexFlow(false);
            setActivePage("generation-flow");
          }}
          onReviewReady={() => {
            setShowCodexFlow(false);
            setActivePage("generation-flow");
          }}
          onQueued={() => {
            setShowCodexFlow(false);
            setActivePage("posts");
            setActiveTab("queued");
            fetchPosts({ tab: "queued" });
          }}
        />
      )}
    </div>
  );
}
