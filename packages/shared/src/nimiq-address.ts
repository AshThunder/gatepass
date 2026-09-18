import { ed25519 } from '@noble/curves/ed25519.js'
import { blake2b } from '@noble/hashes/blake2.js'
import { hexToBytes, utf8ToBytes } from './totp.js'

/** Nimiq user-friendly alphabet (no I/O). */
const NQ_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY'

export function normalizeNqAddress(addr: string): string {
  return addr.replace(/\s+/g, '').toUpperCase()
}

export function addressesEqual(a: string, b: string): boolean {
  return normalizeNqAddress(a) === normalizeNqAddress(b)
}

/** Loose check: NQ + checksum + 32 base32 chars (spaces optional). */
export function isNqAddress(addr: string): boolean {
  const n = normalizeNqAddress(addr)
  return /^NQ[0-9]{2}[0-9A-HJKLMNP-UVXY]{32}$/.test(n)
}

function toBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += NQ_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0)
    out += NQ_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function ibanCheck(str: string): string {
  const num = str.split('').map((c) => {
    const code = c.toUpperCase().charCodeAt(0)
    return code >= 48 && code <= 57 ? c : String(code - 55)
  }).join('')
  let tmp = ''
  for (let i = 0; i < Math.ceil(num.length / 6); i++)
    tmp = String(Number.parseInt(tmp + num.slice(i * 6, i * 6 + 6), 10) % 97)
  return `00${98 - Number.parseInt(tmp, 10)}`.slice(-2)
}

export function addressFromPublicKey(publicKeyHex: string): string {
  const pub = hexToBytes(publicKeyHex)
  const hash = blake2b(pub, { dkLen: 32 })
  const addr = hash.subarray(0, 20)
  const base32 = toBase32(addr)
  const check = ibanCheck(`${base32}NQ00`)
  const raw = `NQ${check}${base32}`
  return raw.replace(/(.{4})/g, '$1 ').trim()
}

function tryVerify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey)
  }
  catch {
    return false
  }
}

/**
 * Verify a Nimiq Pay `sign()` result over `message`.
 * Tries raw UTF-8 and Blake2b-256(message) because hosts hash before signing.
 */
export function verifyNimiqSignature(
  message: string,
  publicKeyHex: string,
  signatureHex: string,
): boolean {
  const pub = hexToBytes(publicKeyHex)
  const sig = hexToBytes(signatureHex)
  const raw = utf8ToBytes(message)
  if (tryVerify(raw, sig, pub))
    return true
  const hashed = blake2b(raw, { dkLen: 32 })
  return tryVerify(hashed, sig, pub)
}
