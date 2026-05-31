import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categorize,
  isProductionOrg,
  parseOrgList,
  scratchRemainingLabel,
  isScratchExpired,
  type RawOrg,
} from "../src/orgManager/orgService.js";

test("isProductionOrg flags prod login + my-domain, spares sandbox/scratch", () => {
  assert.equal(isProductionOrg({ username: "a", loginUrl: "https://login.salesforce.com" }), true);
  assert.equal(
    isProductionOrg({ username: "b", instanceUrl: "https://acme.my.salesforce.com" }),
    true
  );
  assert.equal(
    isProductionOrg({ username: "c", loginUrl: "https://test.salesforce.com" }),
    false
  );
  assert.equal(isProductionOrg({ username: "d", isSandbox: true }), false);
  assert.equal(isProductionOrg({ username: "e", isScratchOrg: true }), false);
});

test("categorize precedence: scratch > sandbox > devhub > production", () => {
  assert.equal(categorize({ username: "s", isScratchOrg: true, isDevHub: true }), "Scratch");
  assert.equal(categorize({ username: "sb", isSandbox: true }), "Sandbox");
  assert.equal(categorize({ username: "dh", isDevHub: true }), "DevHub");
  assert.equal(
    categorize({ username: "p", loginUrl: "https://login.salesforce.com" }),
    "Production"
  );
  assert.equal(categorize({ username: "o" }), "Other");
});

test("parseOrgList flattens, de-dupes by username, and sorts by category", () => {
  const orgs = parseOrgList({
    nonScratchOrgs: [
      {
        username: "prod@acme.com",
        alias: "prod",
        loginUrl: "https://login.salesforce.com",
        isDefaultUsername: true,
        connectedStatus: "Connected",
      } as RawOrg,
      { username: "uat@acme.com", alias: "uat", isSandbox: true, connectedStatus: "Connected" },
    ],
    scratchOrgs: [
      { username: "scr@acme.com", alias: "scr", isScratchOrg: true, status: "Active" },
    ],
    // duplicate of prod in another bucket — should merge, not double.
    other: [{ username: "prod@acme.com", alias: "prod", orgId: "00Dxx" }],
  });

  assert.equal(orgs.length, 3);
  // production sorts first.
  assert.equal(orgs[0].category, "Production");
  assert.equal(orgs[0].displayName, "prod");
  assert.equal(orgs[0].isProduction, true);
  assert.equal(orgs[0].connected, true);
  assert.equal(orgs[0].orgId, "00Dxx"); // merged from the other bucket
  // scratch reports Active -> connected true.
  const scr = orgs.find((o) => o.username === "scr@acme.com")!;
  assert.equal(scr.category, "Scratch");
  assert.equal(scr.connected, true);
});

test("parseOrgList handles empty result and skips records without username", () => {
  assert.deepEqual(parseOrgList({}), []);
  const orgs = parseOrgList({ nonScratchOrgs: [{ alias: "x" } as RawOrg, { username: "u@e.com" }] });
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].username, "u@e.com");
});

test("toOrgInfo: connected derives from status/connectedStatus/scratch", () => {
  const orgs = parseOrgList({
    nonScratchOrgs: [
      { username: "a", status: "Connected" },
      { username: "b", connectedStatus: "Active" },
      { username: "c", connectedStatus: "Disconnected" },
      { username: "d", isScratchOrg: true },
    ],
  });
  const by = (u: string) => orgs.find((o) => o.username === u)!;
  assert.equal(by("a").connected, true);
  assert.equal(by("b").connected, true);
  assert.equal(by("c").connected, false);
  assert.equal(by("d").connected, true);
});

test("scratchRemainingLabel: only scratch, days/expired/invalid", () => {
  const now = Date.UTC(2026, 0, 10);
  assert.equal(scratchRemainingLabel("Sandbox", "2026-01-20", now), undefined);
  assert.equal(scratchRemainingLabel("Scratch", undefined, now), undefined);
  assert.equal(scratchRemainingLabel("Scratch", "bad-date", now), undefined);
  assert.equal(scratchRemainingLabel("Scratch", "2026-01-15", now), "残り5日");
  assert.equal(scratchRemainingLabel("Scratch", "2026-01-05", now), "期限切れ");
});

test("isScratchExpired: true only for past-dated scratch orgs", () => {
  const now = Date.UTC(2026, 0, 10);
  assert.equal(isScratchExpired("Scratch", "2026-01-05", now), true);
  assert.equal(isScratchExpired("Scratch", "2026-01-15", now), false);
  assert.equal(isScratchExpired("Scratch", undefined, now), false);
  assert.equal(isScratchExpired("Scratch", "bad-date", now), false);
  assert.equal(isScratchExpired("Sandbox", "2026-01-05", now), false);
});
