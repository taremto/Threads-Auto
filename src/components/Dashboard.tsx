"use client";

import { useState, useEffect, useCallback } from "react";
import Sidebar from "./Sidebar";
import PostCard from "./PostCard";
import AddAccountModal from "./AddAccountModal";
import OverviewPage from "./OverviewPage";
import SettingsPage from "./SettingsPage";
import GenerateModal from "./GenerateModal";

type Tab = "draft" | "queued" | "posted";
type Page = "posts" | "overview" | "settings";

type Post = {
  id: string;
  groupNo: number;
  body: string;
  postType: string;
  charCount: number;
  score: number | null;
  scheduledDate: string | null;
  scheduledHour: number | null;
  scheduledMin: number | null;
  publishAt: string | null;
  status: string;
  error: string | null;
  createdAt: string;
};

const statusMap: Record<Tab, string> = {
  draft: "draft",
  queued: "queued",
  posted: "posted",
};

const tabLabel: Record<Tab, string> = {
  draft: "下書き",
  queued: "キュー",
  posted: "投稿済み",
};

type AccountLite = { id: string; name: string; cloudOffloadEnabled: boolean };

export default function Dashboard() {
  const [activePage, setActivePage] = useState<Page>("posts");
  const [activeTab, setActiveTab] = useState<Tab>("draft");
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountLite[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [accountVersion, setAccountVersion] = useState(0);
  const [hasAccounts, setHasAccounts] = useState<boolean | null>(null);
  const [customizationWarning, setCustomizationWarning] = useState(false);

  const activeAccount = accounts.find((a) => a.id === activeAccountId) || null;

  const fetchPosts = useCallback(() => {
    if (!activeAccountId) {
      queueMicrotask(() => setPosts([]));
      return;
    }
    fetch(
      `/api/posts?accountId=${activeAccountId}&status=${statusMap[activeTab]}`
    )
      .then((r) => {
        if (!r.ok) return [];
        return r.json();
      })
      .then(setPosts)
      .catch(() => setPosts([]));
  }, [activeAccountId, activeTab]);

  useEffect(() => {
    if (activePage === "posts") fetchPosts();
  }, [fetchPosts, activePage]);

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

  // カスタマイズ適用チェック（バージョンアップ後に未適用なら警告）
  useEffect(() => {
    fetch("/api/customizations")
      .then((r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (data && data.needsReapply) {
          setCustomizationWarning(true);
        }
      })
      .catch(() => {});
  }, []);

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
      fetchPosts();
    } catch (e) {
      alert(`キューに追加できませんでした。\n${String(e)}\n\nもう一度お試しください。`);
      fetchPosts();
    }
  }

  async function updatePostStatus(postId: string, status: string) {
    await fetch("/api/posts/group-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId, action: "status", status }),
    });
    fetchPosts();
  }

  async function deletePost(postId: string) {
    await fetch("/api/posts/group-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId, action: "delete" }),
    });
    fetchPosts();
  }

  async function editPost(postId: string, body: string) {
    await fetch("/api/posts/group-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postId, action: "edit", body }),
    });
    fetchPosts();
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
        (a: { groupNo: number; publishAt: string; preview: string }) =>
          `  ${fmt(a.publishAt)}  #${a.groupNo}  ${a.preview}…`
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
    fetchPosts();
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
    <div className="flex h-screen md:overflow-x-auto">
      {/* デスクトップ: 左サイドバー */}
      <Sidebar
        activePage={activePage}
        onPageChange={setActivePage}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        activeAccountId={activeAccountId}
        onAccountChange={setActiveAccountId}
        onAddAccount={() => setShowAddAccount(true)}
        accountVersion={accountVersion}
      />

      {/* カスタマイズ未適用警告バナー */}
      {customizationWarning && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-orange-50 border-b border-orange-300 px-4 py-3 flex items-center justify-between shadow-sm">
          <p className="text-xs text-orange-700 leading-snug">
            <span className="font-bold">カスタマイズの再適用が必要です。</span>{" "}
            バージョンアップで独自機能が外れています。Claudeに「カスタマイズを再適用して」と伝えてください。
          </p>
          <button
            onClick={() => setCustomizationWarning(false)}
            className="text-orange-400 hover:text-orange-600 text-lg ml-3 shrink-0"
          >
            ✕
          </button>
        </div>
      )}

      {/* メインコンテンツ */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* モバイル: 上部バー（デスクトップでは非表示） */}
        <div className="md:hidden flex items-center justify-between px-4 pt-3 pb-2 border-b border-gray-200 bg-white shrink-0">
          <h1 className="text-base font-bold text-gray-800">Threads Auto</h1>
          {accounts.length > 1 ? (
            <select
              value={activeAccountId || ""}
              onChange={(e) => {
                setActiveAccountId(e.target.value);
                setActivePage("posts");
              }}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1 max-w-[160px] truncate"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-gray-500">{accounts[0]?.name}</span>
          )}
        </div>

        {/* ページ本体 */}
        <div className="flex-1 overflow-y-auto pb-16 md:pb-0">
          {activePage === "overview" && (
            <OverviewPage
              onNavigate={(accountId, tab) => {
                setActiveAccountId(accountId);
                setActiveTab(tab);
                setActivePage("posts");
              }}
            />
          )}
          {activePage === "settings" && <SettingsPage />}
          {activePage === "posts" && (
            <main className="flex-1">
              {/* Top bar */}
              <div className="flex flex-wrap items-center justify-between px-4 md:px-8 pt-4 md:pt-6 pb-3 md:pb-4 gap-2">
                <div>
                  <h2 className="text-lg md:text-xl font-bold text-gray-800">
                    {tabLabel[activeTab]} ({posts.length})
                  </h2>
                  {activeAccount && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      <span className="font-medium text-gray-500 hidden md:inline">
                        アカウント: {activeAccount.name}
                      </span>
                      {activeAccount.cloudOffloadEnabled && (
                        <span className="text-green-600 md:ml-2">☁ クラウドON</span>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {activeTab === "draft" && posts.length > 0 && (
                    <button
                      onClick={bulkQueueAll}
                      className="px-3 md:px-5 py-2 rounded-lg text-xs md:text-sm font-medium text-white transition-opacity hover:opacity-80"
                      style={{ background: "#ff9800" }}
                      title="下書き全件を投稿時間帯に沿って自動でキューに追加"
                    >
                      全件キュー追加
                    </button>
                  )}
                  <button
                    onClick={() => setShowGenerate(true)}
                    className="px-3 md:px-5 py-2 rounded-lg text-xs md:text-sm font-medium text-white"
                    style={{ background: "var(--accent)" }}
                  >
                    AI生成
                  </button>
                </div>
              </div>

              {/* Posts */}
              <div className="px-4 md:px-8 pb-8">
                {activeTab === "queued" &&
                  posts.length > 0 &&
                  activeAccount &&
                  !activeAccount.cloudOffloadEnabled && (
                    <div className="mb-4 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 leading-relaxed">
                      ⚠️ <b>PCスリープ中は投稿されません。</b>
                      PCを閉じていても投稿させたい場合は「設定 → ☁ クラウドオフロード」をセットアップしてください。
                    </div>
                  )}
                {activeAccountId && posts.length === 0 && (
                  <div className="text-center py-16 text-gray-400">
                    <p className="text-base mb-2">
                      {tabLabel[activeTab]}はまだありません
                    </p>
                    {activeTab === "draft" && (
                      <p className="text-sm">「AI生成」ボタンで投稿を生成してください</p>
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
                      onQueue={queuePost}
                      onBackToDraft={(id) => updatePostStatus(id, "draft")}
                      onDelete={deletePost}
                      onEdit={editPost}
                    />
                  );
                })}
              </div>
            </main>
          )}
        </div>
      </div>

      {/* モバイル: 下部ナビゲーションバー */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 flex items-stretch"
        style={{ background: "var(--sidebar-bg)" }}
      >
        {(
          [
            { key: "draft", label: "下書き", page: "posts", icon: "📝" },
            { key: "queued", label: "キュー", page: "posts", icon: "🕐" },
            { key: "posted", label: "投稿済み", page: "posts", icon: "✅" },
            { key: "overview", label: "概要", page: "overview", icon: "📊" },
            { key: "settings", label: "設定", page: "settings", icon: "⚙️" },
          ] as const
        ).map((item) => {
          const isActive =
            item.page === "posts"
              ? activePage === "posts" && activeTab === item.key
              : activePage === item.page;
          return (
            <button
              key={item.key}
              onClick={() => {
                if (item.page === "posts") {
                  setActivePage("posts");
                  setActiveTab(item.key as Tab);
                } else {
                  setActivePage(item.page);
                }
              }}
              className="flex-1 flex flex-col items-center justify-center py-2 text-[10px] gap-0.5 transition-colors"
              style={{
                color: isActive ? "#4fc3f7" : "rgba(255,255,255,0.55)",
              }}
            >
              <span className="text-lg leading-none">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

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
    </div>
  );
}
