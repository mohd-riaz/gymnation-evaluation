import { ApiError } from "./errors";
import { countries, type Country } from "./models";

export function normalizePhone(input: string, country?: Country, lookup = false): string {
  const cleaned = input.replace(/[ ()-]/g, "");
  const fail = (): never => { throw new ApiError(422, "INVALID_PHONE", "Phone must be a supported Gulf mobile number."); };
  if (!/^\+?\d+$/.test(cleaned)) return fail();
  const digits = cleaned.replace(/^\+/, "");
  for (const [code, rules] of Object.entries(countries)) {
    if (digits.startsWith(rules.dial) && rules.mobile.test(digits.slice(rules.dial.length))) {
      if (lookup && country && country !== code) {
        throw new ApiError(422, "PHONE_COUNTRY_MISMATCH", "Phone dial code disagrees with country.");
      }
      return `+${digits}`;
    }
  }
  if (cleaned.startsWith("+")) return fail();
  if (!country) {
    if (Object.values(countries).some((rules) => rules.national.test(cleaned))) {
      throw new ApiError(422, "PHONE_NEEDS_COUNTRY", "National mobile numbers require a country.");
    }
    return fail();
  }
  const rules = countries[country];
  if (!rules.national.test(cleaned)) return fail();
  return `+${rules.dial}${country === "BH" ? cleaned : cleaned.slice(1)}`;
}
