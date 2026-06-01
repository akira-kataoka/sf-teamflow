import { test } from "node:test";
import assert from "node:assert/strict";
import { TEAMFLOW_SCHEMA, schemaJson } from "../src/config/schema.js";

test("schema: 環境プロパティは TeamEnvironment の全フィールドを網羅する", () => {
  const envProps = Object.keys(TEAMFLOW_SCHEMA.properties.environments.items.properties);
  // teamflowConfig.ts の TeamEnvironment と揃っていること（手編集の補完が効くように）。
  for (const k of ["name", "orgAlias", "branch", "type", "baseRef", "testLevel", "requireValidation", "purpose"]) {
    assert.ok(envProps.includes(k), `schema に ${k} が必要`);
  }
});

test("schema: additionalProperties:false でキー名タイポを検出できる", () => {
  assert.equal(TEAMFLOW_SCHEMA.additionalProperties, false, "ルートは未知キー不可");
  assert.equal(
    TEAMFLOW_SCHEMA.properties.environments.items.additionalProperties,
    false,
    "環境項目も未知キー不可"
  );
});

test("schema: testLevel の enum がルート/環境で一致する", () => {
  const root = TEAMFLOW_SCHEMA.properties.testLevel.enum;
  const env = TEAMFLOW_SCHEMA.properties.environments.items.properties.testLevel.enum;
  assert.deepEqual([...env], [...root]);
});

test("schemaJson: 末尾改行付きの妥当なJSONを返す", () => {
  const s = schemaJson();
  assert.ok(s.endsWith("\n"), "末尾は改行");
  const parsed = JSON.parse(s);
  assert.equal(parsed.required[0], "environments");
});
