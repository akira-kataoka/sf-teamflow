## チーム設定を作る (sf-teamflow.json)

「どのブランチが、どの環境（Org）に対応するか」をチームで共有する設定ファイルです。

```json
{
  "environments": [
    { "name": "production", "orgAlias": "prod", "branch": "main",      "type": "production" },
    { "name": "staging",    "orgAlias": "uat",  "branch": "release/*", "type": "sandbox" },
    { "name": "integration","orgAlias": "int",  "branch": "develop",   "type": "sandbox" }
  ]
}
```

これを Git にコミットすれば、全員の VSCode で同じ「環境の意味」が共有されます。
