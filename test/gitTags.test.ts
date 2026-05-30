import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestNextTag } from "../src/git/tagUtils.js";

test("suggestNextTag starts at v1.0.0 when there are no semver tags", () => {
  assert.equal(suggestNextTag([]), "v1.0.0");
  assert.equal(suggestNextTag(["beta", "nightly"]), "v1.0.0");
});

test("suggestNextTag bumps the patch of the highest version", () => {
  assert.equal(suggestNextTag(["v1.0.0", "v1.0.1", "v1.0.2"]), "v1.0.3");
  assert.equal(suggestNextTag(["v1.2.9", "v1.10.0", "v1.3.0"]), "v1.10.1");
  assert.equal(suggestNextTag(["v2.0.0", "v1.9.9"]), "v2.0.1");
});

test("suggestNextTag accepts tags with or without the v prefix", () => {
  assert.equal(suggestNextTag(["1.0.0"]), "v1.0.1");
});
