import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decodeQrPayload,
  deriveTicketSeed,
  encodeQrPayload,
  generateTotp,
  verifyTotp,
} from './totp.js'

/** Fixed seed for golden vectors (32 bytes hex) */
const GOLDEN_SEED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('TOTP 15s window', () => {
  it('matches golden vector at fixed timestamp', async () => {
    // 2026-01-01T00:00:00.000Z
    const now = Date.parse('2026-01-01T00:00:00.000Z')
    const code = await generateTotp(GOLDEN_SEED, now, 15, 6)
    assert.equal(code, '502574')
  })

  it('changes across period boundaries', async () => {
    const t0 = Date.parse('2026-01-01T00:00:00.000Z')
    const a = await generateTotp(GOLDEN_SEED, t0, 15, 6)
    const b = await generateTotp(GOLDEN_SEED, t0 + 15_000, 15, 6)
    assert.notEqual(a, b)
  })

  it('accepts ±1 skew', async () => {
    const now = Date.parse('2026-01-01T00:00:07.000Z')
    const code = await generateTotp(GOLDEN_SEED, now - 15_000, 15, 6)
    assert.equal(await verifyTotp(GOLDEN_SEED, code, now, 15, 1), true)
  })

  it('rejects far-skew codes', async () => {
    const now = Date.parse('2026-01-01T00:00:07.000Z')
    const code = await generateTotp(GOLDEN_SEED, now - 60_000, 15, 6)
    assert.equal(await verifyTotp(GOLDEN_SEED, code, now, 15, 1), false)
  })
})

describe('ticket seed derivation', () => {
  it('is deterministic', async () => {
    const master = 'aa'.repeat(32)
    const a = await deriveTicketSeed(master, 'ticket-1')
    const b = await deriveTicketSeed(master, 'ticket-1')
    const c = await deriveTicketSeed(master, 'ticket-2')
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.equal(a.length, 64)
  })
})

describe('QR payload', () => {
  it('round-trips', () => {
    const raw = encodeQrPayload({ eventId: 'evt1', ticketId: 'tkt1', totp: '123456' })
    assert.equal(raw, 'GP1:evt1:tkt1:123456')
    assert.deepEqual(decodeQrPayload(raw), { eventId: 'evt1', ticketId: 'tkt1', totp: '123456' })
  })

  it('rejects malformed', () => {
    assert.equal(decodeQrPayload('nope'), null)
    assert.equal(decodeQrPayload('GP1:a:b:12'), null)
  })
})
