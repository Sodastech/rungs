// Formatting for display. Times are shown in UTC so the server-rendered text is the same for
// every visitor; Rungs stores ISO 8601 UTC strings.

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const dateTime = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const date = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const formatMoney = (amount: number) => money.format(amount);
export const formatDateTime = (iso: string) => `${dateTime.format(new Date(iso))} UTC`;
export const formatDate = (iso: string) => date.format(new Date(iso));

/** "3 hours ago", "in 2 days", relative to the demo clock. */
export function relative(iso: string, now: Date): string {
  const minutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(minutes);
  const [value, unit] =
    abs < 60
      ? [abs, "minute"]
      : abs < 48 * 60
        ? [Math.round(abs / 60), "hour"]
        : [Math.round(abs / 1440), "day"];
  if (value === 0) return "just now";
  const text = `${value} ${unit}${value === 1 ? "" : "s"}`;
  return minutes < 0 ? `${text} ago` : `in ${text}`;
}

export const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
