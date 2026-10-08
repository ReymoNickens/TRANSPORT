/**
 * Phone numbers are stored in E.164 form (+233XXXXXXXXX). Ghana numbers
 * may be typed as 0XX XXX XXXX, 233XXXXXXXXX or +233 XX XXX XXXX.
 * Returns null when the input is not a valid Ghana mobile number.
 */
export function normaliseGhanaPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, "");
  let national: string;
  if (/^\+233\d{9}$/.test(digits)) national = digits.slice(4);
  else if (/^233\d{9}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{9}$/.test(digits)) national = digits.slice(1);
  else if (/^\d{9}$/.test(digits)) national = digits;
  else return null;
  // Ghana mobile numbers start with 2 or 5 after the country code.
  if (!/^[25]\d{8}$/.test(national)) return null;
  return `+233${national}`;
}

/** Shows only the last digits, for screens and logs (spec 19.4). */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? "****" : `${"*".repeat(phone.length - 3)}${phone.slice(-3)}`;
}
