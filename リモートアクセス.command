#!/bin/bash
cd "$(dirname "$0")" || { echo "フォルダの場所が分かりませんでした。"; read -r -n 1 -s; exit 1; }
bash remote.sh
echo
echo "リモートアクセスを終了しました。もう一度使いたい時は、このファイルをまたダブルクリックしてください。"
echo "（何かキーを押すと閉じます）"
read -r -n 1 -s
