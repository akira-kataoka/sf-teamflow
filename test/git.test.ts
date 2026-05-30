import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyChanges,
  isUnderPackageDirs,
  parseNameStatus,
} from "../src/deploy/gitService.js";

test("parseNameStatus parses adds, mods, deletes and renames", () => {
  const out = [
    "A\tforce-app/main/default/classes/Foo.cls",
    "M\tforce-app/main/default/classes/Bar.cls",
    "D\tforce-app/main/default/classes/Old.cls",
    "R100\tforce-app/main/default/classes/Was.cls\tforce-app/main/default/classes/Now.cls",
  ].join("\n");
  const entries = parseNameStatus(out);
  // rename produces a modify(new) + delete(old)
  assert.deepEqual(
    entries.find((e) => e.path.endsWith("Now.cls")),
    { path: "force-app/main/default/classes/Now.cls", status: "M" }
  );
  assert.ok(entries.some((e) => e.path.endsWith("Was.cls") && e.status === "D"));
  assert.equal(entries.filter((e) => e.status === "D").length, 2);
});

test("isUnderPackageDirs respects directory boundaries and separators", () => {
  assert.equal(isUnderPackageDirs("force-app/main/x.cls", ["force-app"]), true);
  assert.equal(isUnderPackageDirs("force-app\\main\\x.cls", ["force-app"]), true);
  assert.equal(isUnderPackageDirs("force-apple/x.cls", ["force-app"]), false);
  assert.equal(isUnderPackageDirs("docs/readme.md", ["force-app", "shared"]), false);
  assert.equal(isUnderPackageDirs("shared/util.cls", ["force-app", "shared"]), true);
});

test("classifyChanges splits deploy/delete/ignored and de-dupes", () => {
  const cs = classifyChanges(
    [
      { path: "force-app/A.cls", status: "A" },
      { path: "force-app/A.cls", status: "M" }, // dup -> one
      { path: "force-app/B.cls", status: "D" },
      { path: "README.md", status: "M" }, // outside pkg
    ],
    ["force-app"]
  );
  assert.deepEqual(cs.toDeploy, ["force-app/A.cls"]);
  assert.deepEqual(cs.toDelete, ["force-app/B.cls"]);
  assert.deepEqual(cs.ignored, ["README.md"]);
});

test("classifyChanges: a path both deployed and deleted only deploys", () => {
  const cs = classifyChanges(
    [
      { path: "force-app/X.cls", status: "M" },
      { path: "force-app/X.cls", status: "D" },
    ],
    ["force-app"]
  );
  assert.deepEqual(cs.toDeploy, ["force-app/X.cls"]);
  assert.deepEqual(cs.toDelete, []);
});
