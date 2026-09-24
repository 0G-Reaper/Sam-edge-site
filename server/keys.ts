import { randomBytes } from 'node:crypto'

/** Crockford base32: no I, L, O or U, so keys survive being read aloud or typed. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const KEY_PATTERN = /^SAM(?:-[0-9A-HJKMNP-TV-Z]{4}){4}$/

/** 80 random bits rendered as SAM-XXXX-XXXX-XXXX-XXXX. */
export function memberKey(): string {
  const bytes = randomBytes(10)
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = ((value << 8) | b) >>> 0
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(value >>> bits) & 31]
    }
    value &= (1 << bits) - 1
  }
  return `SAM-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`
}
