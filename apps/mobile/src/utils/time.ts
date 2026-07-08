/**
 * Time formatting helpers for chat (F-037).
 * Plain Intl/Date math — no date library dependency.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact relative timestamp for inbox rows: "now", "5m", "3h", "2d", then
 * a short date ("Jun 12" / "Jun 12, 2025" once it crosses a year boundary).
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diff = now.getTime() - then.getTime();

  if (diff < MINUTE_MS) return "now";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d`;

  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Timestamp label shown between message groups in a thread: time-of-day for
 * today ("2:41 PM"), weekday + time within a week ("Tue 2:41 PM"), full short
 * date + time beyond that.
 */
export function formatMessageTimestamp(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const time = then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const diff = now.getTime() - then.getTime();

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (then >= startOfToday) return time;
  if (diff < 7 * DAY_MS) {
    return `${then.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return `${then.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}
