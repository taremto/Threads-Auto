#!/bin/bash
cd "$(dirname "$0")" || { echo "フォルダの場所が分かりませんでした。"; read -r -n 1 -s; exit 1; }
bash start.sh
echo
echo "アプリを停止しました。もう一度起動したい時は、このファイルをまたダブルクリックしてください。"
echo "（何かキーを押すと閉じます）"
read -r -n 1 -s

