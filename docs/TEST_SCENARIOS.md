# Salesforce Dev Manager — 開発ケース別テストシナリオ

初心者が**ゼロの状態**（VSCode拡張は入れたが、プロジェクトもGitもOrgも無い）から、
個人開発 → チーム開発 → リリース → 運用まで進む一連の流れを、**操作・内部コマンド・期待結果・確認観点・エッジケース**で書き起こす。
`✅` は本リポジトリで実コマンド実行により検証済みを示す。

---

## フェーズ0: 何も無い状態（最初の一歩）

### S0-0. ウォークスルー（VS Code「ようこそ／Getting Started」）
- 内部: `contributes.walkthroughs`（プロジェクト準備→環境認証→チーム設定→CI/CD→保存の5ステップ）
- 完了判定: 各ステップに **`completionEvents: onCommand:<実在コマンド>`** を付与。ウォークスルーのボタンからでも、**ホーム画面の同じ操作からでも**、コマンドが実行されればステップが自動でチェックされる（手動操作との二重管理を避ける）。manifest テストで「全ステップが実在コマンドへの onCommand 完了イベントを持つ」ことを固定

### S0-1. フォルダを開いただけ（プロジェクト未作成）
- 前提: SFDXでないフォルダ or 空フォルダを開いた
- 期待: ホームの「次にやること」が **📂 プロジェクト作成** を指す。②開発以降のタイルは無効（グレー）
- 確認観点: `hasProject=false` のとき ②③④⑤ が押せないこと／ヒーローが正しい初手を示すこと
- エッジ: フォルダ未オープン時は各コマンドが「フォルダを開いてください」を出す
- 内部: ヒーロー（次にやること）はホスト側の純粋関数 `computeNextAction()` で決定（フォルダ→プロジェクト→接続切れ再接続→認証→環境設定→**コンフリクト中は解決へ誘導**→保存→同期→**feature ブランチが push済み(upstreamあり)ならPR作成**→**基準ブランチで保留なしなら作業ブランチ作成（次の開発へ）**→calm）。GitHub Flow が一巡する導線。作りたて未pushのブランチには空PRを促さない（`hasUpstream`）。**競合中は変更がカウントされても『保存』を促さず解決を優先**（`conflictCount`・誤コミット防止）。**ローカルとリモートが分岐（ahead かつ behind）しているときは単純 push が non-fast-forward で弾かれるため『先に取り込んでから送る』同期を促す**（ahead だけ見て「送る」と促すと push 拒否で戸惑うのを防ぐ）。単体テストで順序・各分岐を網羅

### S0-3. チーム開発の準備パネル（🚦 網羅的なセットアップ達成度）
- 内部: `computeTeamReadiness({hasProject, orgCount, configured, hasRemote, ciScaffolded})` をホストで算出しwebviewへ。`ciScaffolded` は `.github/workflows/sf-deploy.yml|sf-validate.yml` の存在で判定
- 期待: 5手順（📂プロジェクト→🔌環境認証→🧭環境設定→🐙GitHub接続→🤖CI/CD生成）を ✓/○ で一覧し「N/5 完了」。未完ステップは「▶ 実行」で各コマンド起動／全完了で `<details>` を自動で畳み「仕上げ（任意）: 🔑CI/CDシークレット・🛡️ブランチ保護」を案内
- 認証ステップ（チーム設定あり時）: 「環境を認証（N/M 接続先）」と接続先の認証進捗を表示（`configuredAliasTotal`/`configuredAliasAuthed`）。1件でも認証で done（作業開始可）だが未認証が残ればhintで明示。設定無/接続先情報無なら従来どおり認証済みOrg数で判定
- 確認観点: フォルダ未オープン時は非表示／`doneCount` が done 数と一致（不変条件）／ヒーロー（次の1手）と役割が重複しない（ヒーロー=今やる1つ、パネル=全体像と残り）
- 堅牢化（✅）: 検出が不確実なCIシークレット・ブランチ保護は ✓ 管理せず「仕上げ」導線として案内（誤検出で「未/済」を誤表示しない）。`computeTeamReadiness` は純粋関数で単体テスト

### S0-2. プロジェクト作成
- 操作: 📂 プロジェクト作成
- 内部: `sf project generate --name <名> ...`
- 期待: SFDXプロジェクト一式が生成され、`hasProject=true` に。①の他タイルが点灯
- 確認観点: 生成後ホームが自動更新されるか／`sfdx-project.json` が出来るか／名前検証（`projectNameError`: 英数字始まり必須。`..`や`.hidden`等のフォルダ事故を防ぐ）

---

## フェーズ1: 個人開発ループ（自分のスクラッチ/Sandbox）

### S1-0. 環境を選ぶ（各操作のOrgピッカー共通）
- 表示: 環境選択ピッカーは「★既定 / 表示名」＋**種別を日本語**（`orgCategoryLabel`：本番（お客様が使う）/ Sandbox（検証用）/ Dev Hub / スクラッチ / その他・⚠️本番）＋ユーザー名。**ユーザー名・種別でも絞り込める**（`matchOnDetail`/`matchOnDescription`＝多数の環境がある場合に便利）。`orgCategoryLabel` は純粋関数で単体テスト済（未知値はそのまま）

### S1-1. 環境を認証（ログイン）
- 操作: 環境セクション「＋環境を追加」
- 内部: `sf org login web`（チーム設定があり未認証の接続先があれば `--alias <接続先>` 付き）
- 期待: ブラウザでログイン→環境一覧に追加。既定Orgに設定可能
- 確認観点: 種別（本番/Sandbox/DevHub/Scratch）が日本語説明付きで表示／⚠️本番の警告
- エッジ: セッション失効時は「🔌再接続」が出る
- 機能（チームメンバー向け）: `sf-teamflow.json` がある場合、**未認証の接続先(orgAlias)を候補提示**（`unauthedConfigAliases`）→ 選ぶと `--alias` 付きで認証し、環境に正しく紐づく（別名なしだとユーザー名のままで環境解決できない問題を解消）。「別名を自分で入力」「別名なし」も選べる

### S1-2. Dev Hub準備 → スクラッチ作成
- 操作: 🌳 Dev Hub準備 → 🌱 スクラッチ作成
- 内部: `sf org create scratch --definition-file ... --alias ... --duration-days N --set-default`
- 期待: 数分で使い捨て環境ができ既定に。期限（残りN日）表示
- 確認観点: `config/project-scratch-def.json` 不在時のフォールバック／複数Dev Hub時の選択
- エッジ: Dev Hub未準備→準備へ誘導。期限切れ→グレーアウト＋🗑掃除（✅ isScratchExpired 検証済）
- 失効間近の予告（✅）: 残り**2日以内**のスクラッチは Orgカードの期限表示を**⚠️＋警告色**にして「巻き取り/再作成」を促す（`isScratchExpiringSoon`・しきい値可変・期限切れは赤の従来表示・しきい境界/非スクラッチ/不正日付を単体テスト）。失効でうっかり作業環境を失う前に気づける

### S1-3. 資材作成（Apex/LWC等）
- 操作: ✨ 資材作成 → 種類 → 名前
- 内部: `sf apex generate class --name X --output-dir force-app/main/default/classes`（✅実行確認済）
- 期待: 雛形ファイル生成→自動で開く。失敗時はCLIエラー表示（共有ターミナル経由の無言失敗を解消済）
- 確認観点: 名前バリデーション（`componentNameError`: 英字始まり・**日本語/記号不可**・**Salesforce API名40字上限**）。LWCは小文字始まりcamelCase
- エッジ: ターミナルがビジーでも `run()` 実行なので確実に成否が出る。CLI未インストール時は「コマンドが見つかりません」を明示（`run()` がENOENTをstderrへ）
- テスト誘導（Apexクラス時）: 作成後に**対のテストクラス `<Name>Test` の作成を任意提案**（本番デプロイはApexテストが必須なため）。承諾すると `sf` で生成し**最小 `@isTest` 雛形**（`apexTestStub`：`Test.startTest/stopTest`＋TODO）で上書きして開く。既に末尾 `Test` の名前なら提案しない（`looksLikeTestClass`・FooTestTest 防止）。テスト生成失敗でも本体クラスは残す（純粋関数 `apexTestClassName`/`apexTestStub`/`looksLikeTestClass` は単体テスト済）
- メタデータ取得/反映の種類選択: 39種を**日本語ラベル＋カテゴリ＋英語API名で絞り込める**（`matchOnDetail`/`matchOnDescription`＝「自動化」や「Flow」で検索可）。「その他」手入力は**入力時検証**（`metadataNameError`：「種類」or「種類:メンバー」形式・ワイルドカード可／空白・日本語・`.cls`付き・数字始まりを弾く＝単体テスト済）で sf の不可解な失敗を防ぐ

### S1-4. 資材反映（自分の環境へ push）
- 操作: ⬆️ 資材反映
- 内部: `sf project deploy start --source-dir ...`
- 期待: 自分のスクラッチ/Sandboxに反映。共有環境へは使わない（説明明示済）
- エッジ: ソース追跡の競合→`--ignore-conflicts`の案内（自分の環境はローカル優先）
- 堅牢化（✅）: 反映先に**本番Orgを選んだら強く警告**（modal）し「デプロイ画面へ（差分確認＋二重確認）」へ誘導／「それでも反映する」で続行可。資材反映が本番デプロイの安全確認をバイパスする事故を防ぐ（`org.isProduction` ガード）

### S1-5. 反映してテスト（高速ループ）
- 操作: 🧪（pushAndTest）
- 内部: 反映を `run()` 実行→**成功時のみ**テストをターミナルで実行（✅ `&&` バグ修正済）
- 確認観点: 反映失敗時にテストが走らないこと
- 失敗時の対処ヒント（✅）: 捕捉した出力に対し `sfDeployErrorHint` で**よくある原因を日本語の対処に翻訳**して「💡 …」と添える（カバレッジ75%未満／存在しない項目／権限不足／重複／Apexテスト失敗／コンパイルエラー／必須項目不足。該当なしは生の要約のみ）。単体テスト済

---

## フェーズ2: バージョン管理（Git/GitHub）

### S2-1. Git開始（未管理→初回コミット）✅
- 操作: 💾 バックアップ（Git未管理時）→「Gitを開始する」
- 内部: `git init` → `git add -A` → `git commit`（✅ 一時repoで検証。**PowerShell `&&` 非対応バグは修正済**）
- 期待: 初回コミット作成→そのまま元の操作を続行。repo系タイルが点灯
- 確認観点: 日本語コミットメッセージが通る（✅）／識別情報未設定時はエラー表示

### S2-2. GitHubに接続（公開）✅(分岐検証)
- 操作: 🐙 GitHubに接続 → 名前 → 公開範囲
- 内部: `gh repo create <名> --private --source=. --remote=origin --push`
- 期待: リポジトリ作成＋公開
- 確認観点/エッジ（✅修正済）:
  - 既に origin がある → 「GitHub同期する／接続し直す」を選択（**Unable to add remote バグ修正**）
  - CI/CDのworkflowファイルがある → **workflow scope 不足を検知**し `gh auth refresh -s workflow` を案内
  - 同名リポジトリ存在 / gh未インストール → 個別メッセージ
  - **gh 未ログイン**（最頻の詰まり）→ `isGhNotAuthenticatedError` で検知し「ログインする（`gh auth login`）」をモーダル提示→ターミナルで実行導線（単体テスト済）
  - リポジトリ名検証（`repoNameError`: ASCII英数字と `. - _` のみ、`.`/`..`単体不可）／push失敗は原因別に案内（`pushErrorHint`: 非fast-forward / SSH鍵 / リポジトリ不在 / ネットワーク / 認証）

### S2-3. バックアップ（commit & push）
- 操作: 💾 バックアップ → 種別選択 → メモ
- 内部: `git add -A` → `git commit` →（remoteあれば）`git push`
- 確認観点: 変更0件時「保存するものがありません」／remote未設定時は公開を促す
- 表示: ホームの「📝 保存される変更 N件」と、**保存時の種別選択ピッカーのタイトル**の両方に**種別内訳**（例「新規2・変更3・削除1」）を併記し、保存範囲を一目で把握できる（`summarizeChangeCounts`・**全件から算出**＝一覧が先頭40件のみでも内訳は正確・分かりやすい順で並べ単体テスト済）。ファイル一覧自体も**種別順（新規→変更→削除→…）＋同種内はパス昇順**に整列し（`sortByChangeType`）、内訳ラベルと並びが一致して走査しやすい

### S2-4. GitHubと同期 ✅(分岐検証)
- 操作: 🔄 GitHub同期
- 内部: 上流ありなら `pull --ff-only`→`push`、**上流無し（初回）は `push -u`**（✅ no-tracking バグ修正）
- 確認観点: 初回でも失敗しないこと
- 履歴分岐（ahead かつ behind）時（✅ 実gitで統合テスト）: ff-only の pull が失敗したら手動 git に丸投げせず、**「取り込んで統合する（マージ）」をその場で提案**。承諾すると `git pull --no-rebase`（`pullMerge`）でマージコミットに統合→push まで完結。競合時は**マージ状態を維持**しホームの競合一覧→解決→「バックアップ」で完了（`pullMerge` の ok/conflict を bare remote+clone の分岐シナリオで統合テスト）。「次にやること」の分岐時メッセージ（先に取り込んでから送る）と実挙動が一致

### S2-5. ブランチ管理 ✅
- 操作: 🌿 ブランチ管理（切替/**取り込み(マージ)**/作成/削除）
- 内部: `git switch -c` / `switch` / **`git merge --no-edit`（`mergeBranch`）** / `branch -d`（✅ `feature/検索` 日本語ブランチ検証）
- 確認観点: 作業中ブランチのハイライト／名前検証(`branchNameError`)／**共有基準ブランチ削除時の強い警告(`isProtectedBranch`)**
- 削除の安全網（✅）: 既定は `branch -d`（未マージなら失敗＝安全）。**未マージで失敗したときだけ**「まだどこにも取り込まれていない変更があります。強制削除すると失われます」と明示し、**強制削除(`-D`)の可否をモーダル確認**（`isNotFullyMergedError` で判定・単体テスト）。残したい場合はキャンセルして取り込み/PRへ誘導。未マージ以外のエラーは握りつぶさず上位へ
- 作成UX: 新規作成時は**種別ピッカー**（`branchTypeOptions`：feature/ 新機能・hotfix/ 緊急修正・release/ リリース準備・プレフィックスなし）を先に選び、名前欄に接頭辞をプリフィル。GitHub Flow の規約を示し命名のゆれ（feat/ と feature/ 混在など）を防ぐ
- マージ（✅ 実gitで統合テスト）: 「このブランチを現在のブランチに取り込む」= 他ブランチ(例 develop)を現在ブランチへ `merge`。競合時は**マージ状態を維持**し、ホームの競合一覧→各ファイル解決→「バックアップ」で完了（abortしない）。本流(feature→develop/main)への統合は PR 経由を推奨
- 競合中の脱出口（✅ 実gitで統合テスト）: ホームの競合ボックスに「🛑 やめて取り込み前に戻す（中止）」を追加。確認後 `git merge --abort`（`abortMerge`）で MERGE_HEAD を解消し取り込み前の内容へ復帰。マージ中でなければ ok=false（無害）。`teamflow.abortMerge` コマンド

### S2-6. Pull Request作成
- 操作: 🔀 Pull Request
- 内部: `gh pr create --base <選択> --fill --web`
- 確認観点: マージ先候補はGitHub Flow順（`prBaseCandidates`：release/hotfixからは**main優先**、それ以外は**develop優先**。「おすすめ」ラベルも追従）／ブラウザで内容確認

### S2-7. 変更履歴 ✅
- 操作: 🕘 変更履歴
- 内部: `git log --pretty=%h\t%cr\t%an\t%p\t%s`（✅・`%p`=親ハッシュ）→ 選択で `git show --name-status`（✅）
- 期待: 誰が・いつ・何を→変更ファイル一覧→開く
- 表示: マージコミット（PR取り込み）は一覧で **🔀＋「取り込み(マージ)」** と明示（`CommitInfo.isMerge`／親2つ以上を判定）。ロールバック一覧でも同様
- 堅牢化（✅）: **マージコミット（PR取り込み）でも取り込んだ変更ファイルが見える** — 既定の combined diff は全親と異なるファイルしか出ず空に見えるため、マージ時は `git show --first-parent`（第1親＝取り込み先からの差分）に切替（`isMergeFromRevListParents` で判定）。実gitでマージ/通常の両方を統合テスト

### S2-8. 取り消し（ロールバック）✅
- 操作: ⏪ 取り消し → コミット選択
- 内部: `git revert --no-edit <hash>`（✅）。競合時は `git revert --abort` で**ツリーをクリーンに戻す**（✅検証済）
- 確認観点: 履歴を壊さない（revert方式）／元に戻せる
- 堅牢化（✅）: **マージコミット（PR取り込み）も取り消せる** — 親が2つあるマージは `git revert` に `-m 1`（第1親=取り込み先基準）を自動付与（`isMergeFromRevListParents` で判定）。従来は `-m` 無しで「is a merge but no -m option was given」と失敗していた。通常コミット/マージの両方を実gitで統合テスト

### S2-9. タグ管理 ✅
- 操作: 🏷️ タグ管理
- 内部: `git tag -a` / `git tag --sort=-creatordate`（✅。同時刻作成は副次的に名前順になり得る＝実運用は時刻差で新しい順）
- 機能: タグ作成時は semver の上げ方（修正/新機能/破壊的）を選択（`suggestNextTags`）。push 済み＆`gh`があれば **GitHubリリース作成を任意提案**（`gh release create <tag> --generate-notes`＝マージ済みPR/コミットから変更ノート自動生成・`buildReleaseCreateArgs`）。`gh`が無ければタグのみで完了

---

## フェーズ3: テスト・リリース（共有環境）

### S3-1. テスト実行
- 内部: `sf apex run test --tests ... / RunLocalTests`（✅ 以前 AccountServiceTest 3件pass）
- 確認観点: ローカル全件/クラス指定/全件の選択
- クラス指定UX: **ワークスペースの `*Test.cls` を探して複数選択ピッカーで提示**（名前を記憶に頼らず選べる・`apexClassNameFromPath` で表示名抽出＝区切り混在/大文字拡張子も吸収）。見つからない場合や「✏️ 名前を直接入力」選択時は従来のカンマ区切り手入力にフォールバック（`testClassNamesError` で検証）

### S3-2. デプロイ前チェック（dry-run）
- 内部: `sf project deploy validate`（check-only。本番に触れず可否確認）
- 確認観点: 失敗時に実行ログで原因行が分かる

### S3-3. 環境へデプロイ（共有環境）
- 内部: 環境選択→`sf project deploy start`（git差分。基準refは `resolveBaseRef` で実在refへフォールバック）。差分収集 `changedFiles` は **コミット済み(base...HEAD)＋未コミット＋未追跡** を統合（実gitで統合テスト：追加A/変更M/削除D/未追跡を網羅）
- 堅牢化（✅）: `resolveBaseRef` の存在確認は `rev-parse --verify <ref>`（以前の `^{commit}` 付きは **Windowsで run() が shell:true のため `^` がcmd.exeに食われ常に解決失敗→コミット済み差分を拾えない重大バグ**だった。peel不要なプレーン形に修正・統合テストで回帰防止）
- 確認観点: **本番は確認ダイアログ**／資材反映との違いが説明で分かる／未認証は認証へ誘導
- デプロイ先ピッカーの並び（✅）: 設定の定義順に関わらず **「開発 → … → 本番」の順に整列し本番を末尾**に置く（`sortEnvironmentsForDeploy`：dev→scratch→sandbox→未知→production。同種は定義順を維持＝安定ソート・元配列不変）。タイトルの「開発→ステージング→本番」と実際の並びを一致させ、本番を先頭で誤クリックする事故を減らす（単体テスト済）
- エッジ: **現在ブランチが環境の想定ブランチと不一致なら警告**（`matchBranch`。例 feature のまま本番＝レビュー迂回を防ぐ・続行可）／差分が全てパッケージ外なら「パッケージ外のみ」と補足
- 堅牢化（✅）: デプロイは未コミット/未追跡も含むため、**対象に未コミット（未バックアップ）ファイルがあれば確認画面に件数を明示**（`uncommittedInList`）。「コミットせず反映」事故を黙って起こさず、先にバックアップを促す（続行可）
- 堅牢化（✅）: 確認の強さは `deployConfirmKind` で決定 — 本番＋確認ON＝`production`（🛑検証を勧める）／本番以外でも **`requireValidation` の環境は `validateFirst`**（検証必須設定を実際に強制・従来は表示のみで素通りだった）／検証(お試し)実行は常に `normal`

### S3-4. CI/CD生成
- 内部: `.github/workflows/sf-validate.yml`（PRで検証）/`sf-deploy.yml`（mergeでデプロイ）/`CODEOWNERS`/`pull_request_template.md`（PR説明欄の雛形）生成
- 確認観点: GitHub Flow（feature→develop→main）に対応／要 `workflow` scope（S2-2参照）
- 堅牢化（✅）: 全ジョブ`permissions: contents: read`＋`timeout-minutes: 45`／環境名が同じslugへ衝突するとCIが壊れるため**生成・シークレット設定・ウィザード・ホーム警告の4箇所で衝突検出**（`envSlugCollisions`）／CODEOWNERSのプレースホルダはコメント化
- 堅牢化（✅）: 生成YAMLの deploy/validate は `git diff` 由来の変更ファイルを `-d` で渡すが、**削除されたパスは存在チェック（`[ -e "$f" ]`）で除外**し sf の「Path does not exist」失敗を防ぐ。除外後に対象が空（削除のみ）ならジョブをスキップ。削除の反映は destructiveChanges が別途必要

### S3-5. CI/CDシークレット設定（JWT鍵生成→接続アプリ→gh登録）
- 内部: `ci-keys/server.key|crt` を openssl で生成（`.gitignore` 済）→ 接続アプリ作成チェックリスト（手動）→ 環境ごとに `gh secret/variable set`（`<PREFIX>_CLIENT_ID/USERNAME/JWT_KEY`＋変数 `_INSTANCE_URL`）→ ブランチ保護へ誘導
- 確認観点: gh未ログイン/未接続/鍵未生成の各前提を事前ガード／slug衝突を事前検出
- 堅牢化（✅）: **入力検証**で空値の登録を阻止（`validateInput`）— Consumer Key＝空/内部空白を拒否（`consumerKeyError`）、ユーザー名＝空/空白入りを拒否（`integrationUsernameError`）、ログインURL＝`https://`形式のみ許可（`loginUrlError`）。空のままEnterしてもキャンセル扱いにならず空シークレットが登録されCIが静かに壊れる問題への対処

---

## フェーズ4: 設定・運用

### S4-1. 設定
- 内部: テストレベル / 本番確認 / 基準ブランチ / sf CLIパス / 設定ファイルを開く / VSCode設定
### S4-2. 環境設定（チーム定義の編集・並び替え）✅(plumbing)
- 操作: ① 環境設定 → 既存読込（編集対応済）→ ⠿D&D / ↑↓ で並び替え → 保存
- 確認観点: 既存 sf-teamflow.json をプリフィル／複数・並列環境を自由に構成
- 堅牢化（✅）: チーム設定初期化時、`.forceignore` が**無い/空のときだけ** Salesforce 標準内容（`package.xml`・`**/jsconfig.json`・`**/.eslintrc.json`・`**/__tests__/**`）を作成（`shouldWriteBaselineForceignore`／既存は上書きしない）。除外は普遍的に非デプロイな資産のみ＝実メタデータの取りこぼしは起きない
- 設定lint（`lintTeamflowConfig`・ホームに警告表示）: 環境未定義／**ブランチ重複**／**接続先(orgAlias)重複**（別環境のつもりが同じOrgへ反映される事故を防ぐ）／未認証の接続先／本番未定義 を検出

---

## 横断的な確認観点（全シナリオ共通）
- **シェル非互換**: ターミナルへ `&&`/PowerShell非対応構文を送っていないか（✅ 全 runInTerminal 監査済・残ゼロ）
- **無言の失敗**: fire-and-forget で成否不明にならないか（生成系は `run()` で捕捉）
- **Windows の shell:true による引数破壊**（✅）: `run()` は `.cmd`/`.bat` シム（`sf` 等）だけ shell:true、git/gh/openssl などの実exeは **shell:false** で引数を逐語的に渡す（`needsWinShell`）。これにより (1) `resolveBaseRef` の `^{commit}` の `^` が cmd に食われる問題、(2) コミットメッセージの `& | < > ^ ( )` がコマンド区切り等に化けて保存失敗する問題 を回避。実gitで「特殊文字メッセージのコミット」「ログ整形 `%x09`」を統合テスト
- **sf（shell:true）のスペース/特殊文字入り引数**（✅）: Node の shell:true は引数をエスケープせず連結するだけ（DEP0190）。`run()` は shell が要るとき**自前で cmd 用クォート**（`winCmdQuote`）したコマンド文字列を組み立てて渡す。これで DevHub判定の SOQL `--query "SELECT Id FROM ScratchOrgInfo LIMIT 1"` 等が単語分割されずに sf へ届く（.cmd エコーで実測検証・`winCmdQuote` を単体テスト）
- **日本語**: メッセージ/ブランチ名/コミットは日本語OK、ただし**Apex識別子は不可**
- **未接続/失効**: Org失効・remote無し・上流無し でも親切に案内
- **死にボタン**: ホーム全タイルが実在コマンドに紐づく（✅ 33個確認）
- **ステータスバー（常時表示）**: 既定Org（本番は⚠️＋警告色／未接続は警告色）と「ブランチ → 環境 ↑未バックアップ ↓取り込み ✏未保存」を表示。**現在ブランチが本番環境に割り当たっているときは ⚠️＋警告色**で「いま本番ラインにいる」ことを常時可視化（`formatGitStatusBar` 純粋関数＝本番判定・カウンタ・ツールチップを単体テスト）。クリックで保存（バックアップ）
