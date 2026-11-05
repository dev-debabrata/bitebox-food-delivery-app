import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I

/** `n` random characters from an alphabet without look-alikes (0/O, 1/I). */
export const randomChars = (n) =>
  Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join("");

/** e.g. BB-261102-7KQ4XZ: a prefix, today's date and 6 random characters. */
export function randomCode(prefix) {
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  return `${prefix}-${date}-${randomChars(6)}`;
}
