/** JSON Schema written alongside sf-teamflow.json for editor autocomplete. */
export const TEAMFLOW_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Salesforce Dev Manager configuration",
  type: "object",
  required: ["environments"],
  properties: {
    version: { type: "number", default: 1 },
    defaultBaseRef: {
      type: "string",
      default: "origin/main",
      description: "Git ref a feature deploy is diffed against by default.",
    },
    testLevel: {
      type: "string",
      enum: ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"],
      default: "RunLocalTests",
    },
    packageDirectories: {
      type: "array",
      items: { type: "string" },
      default: ["force-app"],
    },
    environments: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "orgAlias", "branch", "type"],
        properties: {
          name: { type: "string", description: "Environment label, e.g. production." },
          orgAlias: { type: "string", description: "sf org alias to deploy to." },
          branch: {
            type: "string",
            description: "Git branch (or glob, e.g. release/*) mapped to this environment.",
          },
          type: { type: "string", enum: ["production", "sandbox", "scratch", "dev"] },
          baseRef: { type: "string" },
          testLevel: {
            type: "string",
            enum: ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"],
          },
          requireValidation: { type: "boolean" },
          purpose: { type: "string", description: "この環境の役割/用途（例: 結合テスト, UAT）" },
        },
      },
    },
  },
} as const;

export function schemaJson(): string {
  return JSON.stringify(TEAMFLOW_SCHEMA, null, 2) + "\n";
}
