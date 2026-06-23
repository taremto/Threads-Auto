#!/usr/bin/env python3
"""
Claude Code statusLine 橋渡しスクリプト。

Claude Code は対話セッション中、statusLine コマンドに毎回 JSON を stdin で渡す。
その JSON には rate_limits.five_hour / seven_day / context_window の
used_percentage が含まれている（= 右下ポップアップの 29% / 52% の素データ）。

このスクリプトは：
  1. stdin の JSON を受け取り
  2. アプリ（claude-cli.ts の readClaudeRateLimitCache）が読む
     ~/.claude/.ratelimit_cache.json の形式に変換して書き出す
  3. stdin をそのまま本来の statusline 表示スクリプトへ渡す（表示は不変）

設計方針：変換や書き込みで何が起きても、ユーザーの statusLine 表示は
絶対に壊さない（例外は握りつぶして必ず passthrough する）。
"""
import sys, os, json, subprocess, time

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

def main():
    raw = sys.stdin.read()

    # 呼び出し検証用ログ（statusLine が実際に発火したか確認するため。
    # 数値の有無も記録。検証後は消してよい）。
    try:
        d0 = json.loads(raw)
        rl0 = (d0.get("rate_limits") or {})
        fh0 = (rl0.get("five_hour") or {}).get("used_percentage")
        sd0 = (rl0.get("seven_day") or {}).get("used_percentage")
        with open(
            os.path.join(os.path.expanduser("~"), ".claude", "_bridge_invocations.log"),
            "a", encoding="utf-8"
        ) as lg:
            lg.write(
                time.strftime("%Y-%m-%d %H:%M:%S")
                + f"  5h={fh0} 7d={sd0}\n"
            )
    except Exception:
        pass

    # --- 1. アプリ用キャッシュへ変換・書き出し（失敗しても表示は止めない） ---
    try:
        d = json.loads(raw)
        rl = d.get("rate_limits") or {}

        def win(obj):
            if not isinstance(obj, dict):
                return None
            out = {}
            up = obj.get("used_percentage")
            if isinstance(up, (int, float)):
                out["used_percentage"] = up
            ra = obj.get("resets_at") or obj.get("resetsAt")
            if ra:
                out["resets_at"] = ra
            return out or None

        data = {}
        fh = win(rl.get("five_hour"))
        sd = win(rl.get("seven_day"))
        if fh:
            data["five_hour"] = fh
        if sd:
            data["seven_day"] = sd

        if data:
            payload = {"timestamp": int(time.time()), "data": data}
            cache_path = os.path.join(
                os.path.expanduser("~"), ".claude", ".ratelimit_cache.json"
            )
            tmp = cache_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            os.replace(tmp, cache_path)
    except Exception:
        pass  # 表示を止めないため握りつぶす

    # --- 2. 本来の statusline 表示へ passthrough ---
    real = os.path.join(os.path.expanduser("~"), ".claude", "statusline.py")
    try:
        if os.path.isfile(real):
            p = subprocess.run(
                [sys.executable, real],
                input=raw.encode("utf-8"), capture_output=True
            )
            sys.stdout.write((p.stdout or b"").decode("utf-8", "replace"))
        # 本来スクリプトが無ければ何も出さない（statusLine 空表示で無害）
    except Exception:
        pass

if __name__ == "__main__":
    main()
