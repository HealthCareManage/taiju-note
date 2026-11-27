# taiju-note

- `index.html` … 体重・腹囲ノート
- `fx-monitor.html` … 為替急変モニター（ブラウザで開いている間だけ動く版）
- `monitor/` + `.github/workflows/fx-monitor.yml` … 為替急変モニター（スマホを閉じていても動く版）

## スマホで常時監視する（GitHub Actions + ntfy）

GitHub が5分おきに監視プログラムを起動し、急変したらスマホに通知を送ります。サーバーは要りません。

### 設定（最初の1回だけ）
1. スマホに無料アプリ **ntfy**（iPhone / Android）を入れる。
2. 他人に推測されない長い合言葉（トピック名）を決める。例：`fx-` に続けてランダムな英数字20文字ほど。
   ntfy のトピックは知っていれば誰でも読めるので、短い名前や自分の名前は避ける。
3. ntfy アプリで「トピックを追加」し、その合言葉を登録する。
4. GitHub のリポジトリで **Settings → Secrets and variables → Actions → New repository secret** を開き、
   名前を `NTFY_TOPIC`、値を手順2の合言葉にして保存する。
5. **Actions** タブで `fx-monitor` を選び、**Run workflow** を押して動作を確認する。
   以降は5分おきに自動で動く。

### 調整
`monitor/config.json` で、監視する通貨ペア、急変の基準、予想する先の時間などを変えられる。

### 注意
- GitHub の定期実行は混み合うと数分〜十数分遅れることがある。急変の通知もその分遅れる。
- リポジトリが **非公開** の場合、無料枠（月2,000分）を使い切る。公開リポジトリなら無料で使える。
  非公開のまま使うなら、`monitor/config.json` の `runSeconds` を `0` にし、
  `.github/workflows/fx-monitor.yml` の cron を `*/15 * * * *` などに減らす。
- 値動きの記録は `fx-state` ブランチに保存される（1コミットのまま上書きされる）。消しても最初から集め直すだけ。
- 予想は「傾向の目安」で、的中は保証されない。

### 動作確認（パソコンで）
```
node monitor/test.mjs
```
