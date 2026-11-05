export const DAY_MS = 86_400_000;

/** The calendar date of `date` in a time zone: { year, month, day } (month 1-12). */
export function localDate(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

const pad = (n) => String(n).padStart(2, "0");

/** "2026-11-05" in a time zone. */
export function localDay(date, timeZone) {
  const { year, month, day } = localDate(date, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "2026-11" in a time zone. */
export const localMonth = (date, timeZone) => localDay(date, timeZone).slice(0, 7);
