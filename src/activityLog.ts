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

/** Pure relative-time formatter in Japanese. */
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
  return `${Math.floor(hr / 24)}日前`;
}
