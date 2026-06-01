import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestNextTag, suggestNextTags } from "../src/git/tagUtils.js";

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

test("suggestNextTags defaults all levels to v1.0.0 with no current when no tags exist", () => {
  const s = suggestNextTags([]);
  assert.equal(s.current, undefined);
  assert.equal(s.patch, "v1.0.0");
  assert.equal(s.minor, "v1.0.0");
  assert.equal(s.major, "v1.0.0");
  // Same when only non-semver tags are present.
  assert.deepEqual(suggestNextTags(["nightly", "beta"]), {
    patch: "v1.0.0",
    minor: "v1.0.0",
    major: "v1.0.0",
  });
});

test("suggestNextTags bumps patch/minor/major from the highest version", () => {
  const s = suggestNextTags(["v1.2.9", "v1.10.0", "v1.3.0"]);
  assert.equal(s.current, "v1.10.0");
  assert.equal(s.patch, "v1.10.1");
  assert.equal(s.minor, "v1.11.0");
  assert.equal(s.major, "v2.0.0");
});

test("suggestNextTags resets lower components and accepts the v-less prefix", () => {
  const s = suggestNextTags(["2.4.7"]);
  assert.equal(s.current, "v2.4.7");
  assert.equal(s.patch, "v2.4.8");
  assert.equal(s.minor, "v2.5.0");
  assert.equal(s.major, "v3.0.0");
});

test("suggestNextTag and suggestNextTags agree on the patch bump", () => {
  for (const tags of [["v0.9.9"], ["v1.0.0", "v1.2.3"], ["3.3.3"]]) {
    assert.equal(suggestNextTags(tags).patch, suggestNextTag(tags));
  }
});
