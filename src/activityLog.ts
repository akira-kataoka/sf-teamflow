/**
 * Lightweight recent-activity log persisted in VSCode globalState. Records the
 * few actions the home view surfaces ("最近の操作") so a developer can see what
 * just happened (save / deploy / test) and when. Kept vscode-free (takes a
 * minimal key-value store) so it is unit-testable.
 */
export type ActivityStatus = "ok" | "error" | "run";

export interface ActivityEntry {
  time: number;
  label: string;
  status: ActivityStatus;
}

export interface KeyValueStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | void;
}

const KEY = "teamflow.activity";
const MAX = 20;

export class ActivityLog {
  constructor(private readonly store: KeyValueStore) {}

  /** Prepend an entry (newest first), capped at MAX. `nowMs` injected for tests. */
  record(label: string, status: ActivityStatus, nowMs: number): void {
    const list = [{ time: nowMs, label, status }, ...this.all()].slice(0, MAX);
    void this.store.update(KEY, list);
  }

  all(): ActivityEntry[] {
    return this.store.get<ActivityEntry[]>(KEY, []);
  }

  recent(n = 3): ActivityEntry[] {
    return this.all().slice(0, n);
  }
}

/**
 * Count how many deploy actions are recorded (label starts with "デプロイ").
 * Used for the home "リリース回数" stat. Pure & unit-tested.
 */
export function countDeploys(entries: ActivityEntry[]): number {
  return entries.filter((e) => e.label.startsWith("デプロイ")).length;
}

export interface ActivityStats {
  /** デプロイ実行回数 */
  deploys: number;
  /** テスト実行回数 */
  tests: number;
  /** 保存(バックアップ)回数 */
  saves: number;
}

/**
 * Aggregate handy dev metrics from the activity log by matching the label
 * prefixes the command layer records. Pure & unit-tested.
 */
export function computeStats(entries: ActivityEntry[]): ActivityStats {
  let deploys = 0;
  let tests = 0;
  let saves = 0;
  for (const e of entries) {
    if (e.label.startsWith("デプロイ")) {
      deploys++;
    } else if (e.label.startsWith("テスト実行") || e.label.startsWith("反映してテスト")) {
      tests++;
    } else if (e.label.startsWith("保存")) {
      saves++;
    }
  }
  return { deploys, tests, saves };
}

/**
 * Pure relative-time formatter in Japanese. 古い項目は日数が大きくなって読みにくい
 * ので、7日以上は週、約30日以上は月、365日以上は年でまるめる（活動ログの表示用）。
 */
export function relativeTime(fromMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - fromMs);
  const min = Math.floor(diff / 60_000);
  if (min < 1) {
    return "たった今";
  }
  if (min < 60) {
    return `${min}分前`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}時間前`;
  }
  const day = Math.floor(hr / 24);
  if (day < 7) {
    return `${day}日前`;
  }
  if (day < 30) {
    return `${Math.floor(day / 7)}週間前`;
  }
  if (day < 365) {
    return `${Math.floor(day / 30)}か月前`;
  }
  return `${Math.floor(day / 365)}年前`;
}
