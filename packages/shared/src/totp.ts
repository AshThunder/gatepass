import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  QR_PREFIX,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from './types.js'

/**
 * Pure JS HMAC via @noble/hashes — works on http:// LAN and WebViews
 * where crypto.subtle is unavailable (non-secure contexts).
 */
function hmacSha1(keyBytes: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha1, keyBytes, message)
}

function hmacSha256(keyBytes: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, keyBytes, message)
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '')
  if (clean.length % 2 !== 0)
    throw new Error('Invalid hex length')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Generate a 32-byte random secret as hex. */
export function generateMasterSecret(): string {
  const bytes = new Uint8Array(32)
  const c = globalThis.crypto
  if (!c?.getRandomValues)
    throw new Error('Secure random unavailable')
  c.getRandomValues(bytes)
  return bytesToHex(bytes)
}

/** ticketSeed = HMAC-SHA256(masterSecret, ticketId) as hex */
export async function deriveTicketSeed(masterSecretHex: string, ticketId: string): Promise<string> {
  const mac = hmacSha256(hexToBytes(masterSecretHex), utf8ToBytes(ticketId))
  return bytesToHex(mac)
}

function counterToBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8)
  let n = counter
  for (let i = 7; i >= 0; i--) {
    buf[i] = n & 0xff
    n = Math.floor(n / 256)
  }
  return buf
}

/**
 * RFC 6238-style TOTP with configurable period (default 15s) and 6 digits.
 */
export async function generateTotp(
  seedHex: string,
  nowMs: number = Date.now(),
  periodSeconds: number = TOTP_PERIOD_SECONDS,
  digits: number = TOTP_DIGITS,
): Promise<string> {
  const counter = Math.floor(nowMs / 1000 / periodSeconds)
  const hash = hmacSha1(hexToBytes(seedHex), counterToBytes(counter))
  const offset = hash[hash.length - 1]! & 0x0f
  const binary
    = ((hash[offset]! & 0x7f) << 24)
      | ((hash[offset + 1]! & 0xff) << 16)
      | ((hash[offset + 2]! & 0xff) << 8)
      | (hash[offset + 3]! & 0xff)
  const otp = binary % 10 ** digits
  return otp.toString().padStart(digits, '0')
}

/**
 * Validate TOTP allowing ±1 time-step skew.
 */
export async function verifyTotp(
  seedHex: string,
  code: string,
  nowMs: number = Date.now(),
  periodSeconds: number = TOTP_PERIOD_SECONDS,
  skewSteps: number = 1,
): Promise<boolean> {
  const normalized = code.replace(/\s/g, '')
  for (let delta = -skewSteps; delta <= skewSteps; delta++) {
    const t = nowMs + delta * periodSeconds * 1000
    const expected = await generateTotp(seedHex, t, periodSeconds)
    if (expected === normalized)
      return true
  }
  return false
}

/** Seconds remaining in the current TOTP window */
export function totpSecondsRemaining(
  nowMs: number = Date.now(),
  periodSeconds: number = TOTP_PERIOD_SECONDS,
): number {
  const elapsed = Math.floor(nowMs / 1000) % periodSeconds
  return periodSeconds - elapsed
}

export interface QrPayload {
  eventId: string
  ticketId: string
  totp: string
}

/** Encode rotating QR content: GP1:eventId:ticketId:totp */
export function encodeQrPayload(payload: QrPayload): string {
  return `${QR_PREFIX}:${payload.eventId}:${payload.ticketId}:${payload.totp}`
}

export function decodeQrPayload(raw: string): QrPayload | null {
  const parts = raw.trim().split(':')
  if (parts.length !== 4)
    return null
  const [prefix, eventId, ticketId, totp] = parts
  if (prefix !== QR_PREFIX || !eventId || !ticketId || !totp)
    return null
  if (!/^\d{6}$/.test(totp))
    return null
  return { eventId, ticketId, totp }
}

/** Gate unlock QR embeds master material for bouncer devices */
export function encodeGateUnlock(eventId: string, masterSecret: string, unlockToken: string): string {
  return `GPGATE:${eventId}:${masterSecret}:${unlockToken}`
}

export function decodeGateUnlock(raw: string): { eventId: string, masterSecret: string, unlockToken: string } | null {
  const cleaned = raw.trim().replace(/\s+/g, '')
  if (!cleaned.startsWith('GPGATE:'))
    return null
  const parts = cleaned.split(':')
  if (parts.length !== 4 || parts[0] !== 'GPGATE')
    return null
  const [, eventId, masterSecret, unlockToken] = parts
  if (!eventId || !masterSecret || !unlockToken)
    return null
  if (!/^[0-9a-fA-F]+$/.test(masterSecret))
    return null
  return { eventId, masterSecret, unlockToken }
}

/** Staff unlock QR — event + PIN; gate calls staff-unlock API */
export function encodeStaffUnlock(eventId: string, passcode: string): string {
  return `GPSTAFF:${eventId}:${passcode.trim()}`
}

export function decodeStaffUnlock(raw: string): { eventId: string, passcode: string } | null {
  const cleaned = raw.trim().replace(/\s+/g, '')
  if (!cleaned.startsWith('GPSTAFF:'))
    return null
  const parts = cleaned.split(':')
  if (parts.length < 3 || parts[0] !== 'GPSTAFF')
    return null
  const eventId = parts[1]
  const passcode = parts.slice(2).join(':')
  if (!eventId || !passcode)
    return null
  return { eventId, passcode }
}
