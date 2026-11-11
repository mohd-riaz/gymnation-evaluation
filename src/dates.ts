import { ApiError, invalid } from "./errors";

const DAY = 86_400_000;
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// UTC epoch days keep date arithmetic independent of local time and DST.
export function epochDay(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime() / DAY;
}

export function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid("Date must be YYYY-MM-DD.");
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return invalid("Date must be a real calendar date in years 0001–9999.");
  }
  return epochDay(year, month, day);
}

export function monthIndex(value: string): number {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
}

export function dueDate(index: number, anchor: number): { day: number; text: string } {
  const year = Math.floor(index / 12);
  const month = index % 12 + 1;
  const day = Math.min(anchor, daysInMonth(year, month));
  return {
    day: epochDay(year, month, day),
    text: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function validateRange(from: string, to: string): { fromDay: number; toDay: number } {
  const fromDay = parseDate(from);
  const toDay = parseDate(to);
  if (toDay < fromDay || toDay - fromDay > 366) {
    throw new ApiError(422, "INVALID_RANGE", "Range must be ordered and span at most 366 days.");
  }
  return { fromDay, toDay };
}

export function monthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith("0000")) {
    return invalid("Month must be YYYY-MM in years 0001–9999.");
  }
  return { from: `${month}-01`, to: `${month}-${daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5)))}` };
}
