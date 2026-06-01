/** JSON Schema written alongside sf-teamflow.json for editor autocomplete. */
export const TEAMFLOW_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Salesforce Dev Manager configuration",
  type: "object",
  required: ["environments"],
  // 手編集時のキー名タイポ（例: orgAlias→orgalias）をエディタが赤線で知らせるよう、
  // 宣言済み以外のプロパティは許可しない。
  additionalProperties: false,
  properties: {
    version: { type: "number", default: 1, description: "設定ファイルのバージョン（通常は 1）。" },
    defaultBaseRef: {
      type: "string",
      default: "origin/main",
      description: "Git ref a feature deploy is diffed against by default.",
    },
    testLevel: {
      type: "string",
      enum: ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"],
      default: "RunLocalTests",
      description: "デプロイ時の既定テストレベル（環境ごとに上書き可）。",
    },
    packageDirectories: {
      type: "array",
      items: { type: "string" },
      default: ["force-app"],
      description: "デプロイ対象のパッケージディレクトリ（sfdx-project.json と揃える）。",
    },
    environments: {
      type: "array",
      description: "デプロイ先の環境一覧（開発/ステージング/本番など）。",
      items: {
        type: "object",
        required: ["name", "orgAlias", "branch", "type"],
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Environment label, e.g. production." },
          orgAlias: { type: "string", description: "sf org alias to deploy to." },
          branch: {
            type: "string",
            description: "Git branch (or glob, e.g. release/*) mapped to this environment.",
          },
          type: {
            type: "string",
            enum: ["production", "sandbox", "scratch", "dev"],
            description: "環境種別。production は CI で常にテスト実行・確認ダイアログの対象。",
          },
          baseRef: {
            type: "string",
            description: "この環境向けデプロイの差分基準ref（未指定なら defaultBaseRef）。",
          },
          testLevel: {
            type: "string",
            enum: ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"],
            description: "この環境のテストレベル（未指定なら全体の testLevel）。",
          },
          requireValidation: {
            type: "boolean",
            description: "true なら CI でデプロイ前に validate（check-only）を必須にする。",
          },
          purpose: { type: "string", description: "この環境の役割/用途（例: 結合テスト, UAT）" },
        },
      },
    },
  },
} as const;

export function schemaJson(): string {
  return JSON.stringify(TEAMFLOW_SCHEMA, null, 2) + "\n";
}
