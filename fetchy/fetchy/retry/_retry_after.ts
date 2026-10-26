import { type Duration, Second } from '@caffeinejs/std/duration'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const RFC850 =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const ASCTIME = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/

export function retryAfter(value: string | null, now: number): Duration | undefined {
  if (value === null) {
    return undefined
  }

  const text = value.trim()

  if (/^\d+$/.test(text)) {
    // Overflow remains an excessive wait, not a malformed header that would allow an early retry.
    return Number(text) * Second
  }

  let parts: string[] | null = IMF_FIXDATE.exec(text) ?? RFC850.exec(text)

  if (parts === null) {
    const match = ASCTIME.exec(text)
    if (match === null) {
      return undefined
    }

    const [whole, month, day, hour, minute, second, year] = match
    parts = [whole, day, month, year, hour, minute, second]
  }

  const [, dayText, monthText, yearText, hourText, minuteText, secondText] = parts
  const day = Number(dayText)
  const month = MONTHS.indexOf(monthText)
  let year = Number(yearText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)

  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return undefined
  }

  const future = new Date(now)
  future.setUTCFullYear(future.getUTCFullYear() + 50)

  if (yearText.length === 2) {
    year += Math.floor(future.getUTCFullYear() / 100) * 100
  }

  // Construct in UTC, including asctime's implicit zone and years below 100.
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(hour, minute, Math.min(second, 59), 0)

  if (yearText.length === 2 && date.getTime() > future.getTime()) {
    year -= 100
    date.setUTCFullYear(year, month, day)
  }

  // Date normalizes impossible calendar dates; those must fall back to the configured delay.
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return undefined
  }

  const timestamp = date.getTime() + (second === 60 ? Second : 0)
  return Math.max(0, timestamp - now)
}
