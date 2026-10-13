// RFC 9110 sections 5.6.7 and 10.2.3 require all three HTTP-date forms in UTC.
// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7
const imfDate =
  /^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<day>\d{2}) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<year>\d{4}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/u

const rfc850Date =
  /^(?<weekday>Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?<day>\d{2})-(?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(?<year>\d{2}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/u

const asctimeDate =
  /^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?<day>\d{2}| \d) (?<time>\d{2}:\d{2}:\d{2}) (?<year>\d{4})$/u

type DateParts = {
  readonly weekday: string
  readonly day: string
  readonly month: string
  readonly year: string
  readonly time: string
}

function dateParts(value: string): DateParts | undefined {
  const groups = (
    imfDate.exec(value) ??
    rfc850Date.exec(value) ??
    asctimeDate.exec(value)
  )?.groups

  if (
    groups?.weekday === undefined ||
    groups.day === undefined ||
    groups.month === undefined ||
    groups.year === undefined ||
    groups.time === undefined
  ) {
    return undefined
  }
  return {
    weekday: groups.weekday,
    day: groups.day,
    month: groups.month,
    year: groups.year,
    time: groups.time
  }
}

function canonicalDate(parts: DateParts, year: number): string {
  const time = parts.time.endsWith(':60')
    ? `${parts.time.slice(0, -2)}59`
    : parts.time

  return `${parts.weekday.slice(0, 3)}, ${parts.day.trim().padStart(2, '0')} ${parts.month} ${String(year).padStart(4, '0')} ${time} GMT`
}

/** Parse only native HTTP dates, including the RFC850 rolling two-digit year. */
export function httpDate(value: string, now: number): number | undefined {
  const parts = dateParts(value)
  if (parts === undefined) {
    return undefined
  }
  const obsoleteYear = parts.year.length === 2
  const current = new Date(now)
  let year = Number(parts.year)
  if (obsoleteYear) {
    // Choose the rolling century ending 50 years ahead, then apply the full timestamp cutoff.
    year += Math.floor((current.getUTCFullYear() + 50) / 100) * 100
  }
  let canonical = canonicalDate(parts, year)
  let date = new Date(canonical)
  const leapSecond = parts.time.endsWith(':60') ? 1000 : 0
  const future = new Date(now)
  future.setUTCFullYear(future.getUTCFullYear() + 50)
  if (obsoleteYear && date.getTime() + leapSecond > future.getTime()) {
    year -= 100
    canonical = canonicalDate(parts, year)
    date = new Date(canonical)
  }
  return date.toUTCString() === canonical
    ? date.getTime() + leapSecond
    : undefined
}
