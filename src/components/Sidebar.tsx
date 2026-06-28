"use client";

import { useState, useEffect } from "react";

type Account = {
  id: string;
  name: string;
  threadsUsername: string | null;
  _count: { posts: number };
};

type Tab = "draft" | "queued" | "posted" | "error";
type Page =
  | "posts"
  | "overview"
  | "analytics"
  | "competitor"
  | "settings"
  | "knowledge"
  | "generation-flow";

type SidebarProps = {
  activePage: Page;
  onPageChange: (page: Page) => void;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  activeAccountId: string | null;
  onAccountChange: (id: string) => void;
  onAddAccount: () => void;
  accountVersion: number;
};

export default function Sidebar({
  activePage,
  onPageChange,
  activeTab,
  onTabChange,
  activeAccountId,
  onAccountChange,
  onAddAccount,
  accountVersion,
}: SidebarProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => {
        if (!r.ok) return [];
        return r.json();
      })
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, [accountVersion]);

  const tabs: { key: Tab; label: string }[] = [
    { key: "draft", label: "下書き" },
    { key: "queued", label: "キュー" },
    { key: "posted", label: "投稿済み" },
    { key: "error", label: "エラー" },
  ];

  const menuItems: { key: Page; label: string }[] = [
    { key: "overview", label: "全体概要" },
    { key: "analytics", label: "分析" },
    { key: "competitor", label: "競合分析" },
    { key: "generation-flow", label: "生成フロー" },
    { key: "knowledge", label: "ナレッジ" },
    { key: "settings", label: "アカウント設定" },
  ];

  return (
    <aside
      className="flex flex-col w-56 h-screen min-h-screen shrink-0"
      style={{ background: "var(--sidebar-bg)" }}
    >
      {/* Logo */}
      <div className="px-5 pt-6 pb-2">
        <div className="flex items-center gap-2.5">
          <span
            className="grid h-8 w-8 place-items-center rounded-xl text-white text-sm font-bold shadow-lg"
            style={{
              background: "linear-gradient(135deg, #6366f1 0%, #38bdf8 100%)",
              boxShadow: "0 6px 16px -6px rgba(79,124,247,0.8)",
            }}
          >
            T
          </span>
          <div className="leading-tight">
            <h1
              className="text-lg font-bold tracking-tight"
              style={{
                background: "linear-gradient(90deg, #ffffff 0%, #b7c6ff 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              Threads Auto
            </h1>
            <p
              className="text-[11px] tracking-wide"
              style={{ color: "var(--sidebar-text)" }}
            >
              ダッシュボード
            </p>
          </div>
        </div>
      </div>

      {/* Menu */}
      <nav className="mt-4 px-3">
        <p
          className="text-[10px] uppercase tracking-widest px-2 mb-1"
          style={{ color: "var(--sidebar-text)" }}
        >
          メニュー
        </p>
        {menuItems.map((item) => (
          <button
            key={item.key}
            onClick={() => onPageChange(item.key)}
            className="w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors"
            style={{
              background:
                activePage === item.key ? "var(--sidebar-hover)" : "transparent",
              color:
                activePage === item.key ? "#fff" : "var(--sidebar-text)",
            }}
            onMouseEnter={(e) => {
              if (activePage !== item.key)
                e.currentTarget.style.background = "var(--sidebar-hover)";
            }}
            onMouseLeave={(e) => {
              if (activePage !== item.key)
                e.currentTarget.style.background = "transparent";
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* Accounts */}
      <div className="mt-5 px-3 min-h-0 flex flex-col">
        <p
          className="text-[10px] uppercase tracking-widest px-2 mb-2"
          style={{ color: "var(--sidebar-text)" }}
        >
          アカウント
        </p>
        <div className="max-h-[calc(100vh-360px)] min-h-0 space-y-1 overflow-y-auto pr-1">
          {accounts.map((acc) => (
            <button
              key={acc.id}
              onClick={() => {
                onAccountChange(acc.id);
                onPageChange("posts");
              }}
              className="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors truncate"
              style={{
                background:
                  activeAccountId === acc.id && activePage === "posts"
                    ? "var(--sidebar-active)"
                    : "transparent",
                color:
                  activeAccountId === acc.id && activePage === "posts"
                    ? "#fff"
                    : "var(--sidebar-text)",
              }}
            >
              {acc.name}
            </button>
          ))}
        </div>
        <button
          onClick={onAddAccount}
          className="mt-1 w-full text-left px-3 py-2 rounded-lg text-sm transition-colors"
          style={{ color: "var(--sidebar-text)" }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "var(--sidebar-hover)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
        >
          + アカウント追加
        </button>
      </div>

      {/* Tabs (投稿ページのときだけ表示) */}
      {activePage === "posts" && (
        <div className="mt-4 px-3 space-y-0.5">
          <p
            className="px-2 pb-1 text-[10px] uppercase tracking-widest"
            style={{ color: "var(--sidebar-text)" }}
          >
            投稿
          </p>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => onTabChange(t.key)}
              className="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors"
              style={{
                background:
                  activeTab === t.key ? "var(--sidebar-active)" : "transparent",
                color: activeTab === t.key ? "#fff" : "var(--sidebar-text)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-3 flex-1" />
    </aside>
  );
}
