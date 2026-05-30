import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityLog, relativeTime, type KeyValueStore } from "../src/activityLog.js";

function fakeStore(): KeyValueStore {
  const data: Record<string, unknown> = {};
  return {
    get<T>(k: string, def: T): T {
      return (k in data ? (data[k] as T) : def);
    },
    update(k: string, v: unknown) {
      data[k] = v;
    },
  };
}

test("ActivityLog records newest-first and caps at 20", () => {
  const log = new ActivityLog(fakeStore());
  for (let i = 0; i < 25; i++) {
    log.record("op" + i, "ok", 1000 + i);
  }
  const all = log.all();
  assert.equal(all.length, 20);
  assert.equal(all[0].label, "op24");
  assert.equal(log.recent(3).map((e) => e.label).join(","), "op24,op23,op22");
});

test("ActivityLog stores status", () => {
  const log = new ActivityLog(fakeStore());
  log.record("デプロイ", "run", 5);
  log.record("保存", "error", 6);
  assert.deepEqual(log.recent(2).map((e) => e.status), ["error", "run"]);
});

test("relativeTime formats minutes/hours/days", () => {
  const now = 1_000_000_000;
  assert.equal(relativeTime(now, now), "たった今");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5分前");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3時間前");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2日前");
});

test("relativeTime: future timestamps clamp to たった今", () => {
  const now = 1_000_000_000;
  assert.equal(relativeTime(now + 99_999, now), "たった今");
});

test("relativeTime: boundaries (59min, 60min->1時間, 23h, 24h->1日)", () => {
  const now = 1_000_000_000;
  assert.equal(relativeTime(now - 59 * 60_000, now), "59分前");
  assert.equal(relativeTime(now - 60 * 60_000, now), "1時間前");
  assert.equal(relativeTime(now - 23 * 3_600_000, now), "23時間前");
  assert.equal(relativeTime(now - 24 * 3_600_000, now), "1日前");
});

test("ActivityLog: recent(n) on empty store is [] and respects n", () => {
  const log = new ActivityLog(fakeStore());
  assert.deepEqual(log.recent(3), []);
  log.record("a", "ok", 1);
  log.record("b", "ok", 2);
  assert.equal(log.recent(1).length, 1);
  assert.equal(log.recent(1)[0].label, "b");
  assert.equal(log.recent(99).length, 2);
});

test("ActivityLog: get returns default array independently each call", () => {
  const store = fakeStore();
  const log = new ActivityLog(store);
  assert.deepEqual(log.all(), []);
  log.record("x", "run", 5);
  assert.equal(log.all().length, 1);
});
