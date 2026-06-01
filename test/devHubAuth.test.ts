import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  devHubAuthFileCandidates,
  refreshDevHubAuthFlag,
} from "../src/orgManager/devHubAuth.js";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sftf-auth-"));
}

test("devHubAuthFileCandidates covers both .sfdx and .sf locations", () => {
  const c = devHubAuthFileCandidates("u@e.com", "/home/x");
  assert.deepEqual(c, [
    path.join("/home/x", ".sfdx", "u@e.com.json"),
    path.join("/home/x", ".sf", "u@e.com.json"),
  ]);
});

test("refreshDevHubAuthFlag flips a stale isDevHub:false to true, preserving other fields", async () => {
  const home = tmpHome();
  const dir = path.join(home, ".sfdx");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "u@e.com.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ username: "u@e.com", accessToken: "secret", isDevHub: false }),
    "utf8"
  );

  const ok = await refreshDevHubAuthFlag("u@e.com", home);
  assert.equal(ok, true);

  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.isDevHub, true);
  assert.equal(after.accessToken, "secret"); // untouched
  assert.equal(after.username, "u@e.com");
});

test("refreshDevHubAuthFlag returns true when already enabled (no-op)", async () => {
  const home = tmpHome();
  const dir = path.join(home, ".sf");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "u@e.com.json"),
    JSON.stringify({ username: "u@e.com", isDevHub: true }),
    "utf8"
  );
  assert.equal(await refreshDevHubAuthFlag("u@e.com", home), true);
});

test("refreshDevHubAuthFlag returns false when no auth record exists", async () => {
  const home = tmpHome();
  assert.equal(await refreshDevHubAuthFlag("missing@e.com", home), false);
});

test("refreshDevHubAuthFlag: 壊れたJSONの認証ファイルでクラッシュせず false を返す", async () => {
  const home = tmpHome();
  const dir = path.join(home, ".sfdx");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "u@e.com.json");
  fs.writeFileSync(file, "{ this is not valid json", "utf8");
  // 例外を投げず false（呼び出し側は再認証へフォールバックできる）。
  assert.equal(await refreshDevHubAuthFlag("u@e.com", home), false);
  // 壊れたファイルは書き換えない
  assert.equal(fs.readFileSync(file, "utf8"), "{ this is not valid json");
});

test("refreshDevHubAuthFlag leaves a mismatched username file alone", async () => {
  const home = tmpHome();
  const dir = path.join(home, ".sfdx");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "u@e.com.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ username: "other@e.com", isDevHub: false }),
    "utf8"
  );
  assert.equal(await refreshDevHubAuthFlag("u@e.com", home), false);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.isDevHub, false); // untouched
});
