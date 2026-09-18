import { createHash, randomBytes } from 'node:crypto'
import {
  addressFromPublicKey,
  addressesEqual,
  isNqAddress,
  verifyNimiqSignature,
  type AuthChallengeResponse,
  type AuthSessionRequest,
  type AuthSessionResponse,
} from '@gatepass/shared'
import { nanoid } from 'nanoid'
import { db } from '../db.js'
import { allowSkipVerify } from '../nimiq-rpc.js'
import { HttpError } from './events.js'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 60 * 60 * 1000

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function pruneExpired() {
  const now = new Date().toISOString()
  db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(now)
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now)
}

export function createChallenge(): AuthChallengeResponse {
  pruneExpired()
  const nonce = `gp:${nanoid(24)}:${randomBytes(8).toString('hex')}`
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()
  db.prepare('INSERT INTO auth_challenges (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt)
  return { nonce, expiresAt }
}

function consumeChallenge(nonce: string) {
  pruneExpired()
  const row = db.prepare('SELECT nonce, expires_at FROM auth_challenges WHERE nonce = ?').get(nonce) as
    | { nonce: string, expires_at: string }
    | undefined
  if (!row)
    throw new HttpError(400, 'Unknown or expired challenge')
  if (row.expires_at < new Date().toISOString())
    throw new HttpError(400, 'Challenge expired — request a new one')
  db.prepare('DELETE FROM auth_challenges WHERE nonce = ?').run(nonce)
}

export function createSession(body: AuthSessionRequest): AuthSessionResponse {
  if (!body?.nonce)
    throw new HttpError(400, 'nonce required')
  consumeChallenge(body.nonce)

  let address = (body.address || '').trim()
  if (body.demo) {
    if (!allowSkipVerify())
      throw new HttpError(403, 'Demo sessions are disabled')
    if (!address)
      throw new HttpError(400, 'address required for demo session')
  }
  else {
    if (!body.publicKey || !body.signature)
      throw new HttpError(400, 'publicKey and signature required')
    if (!verifyNimiqSignature(body.nonce, body.publicKey, body.signature))
      throw new HttpError(401, 'Invalid signature')
    const derived = addressFromPublicKey(body.publicKey)
    if (address && !addressesEqual(address, derived))
      throw new HttpError(401, 'Address does not match signed public key')
    address = derived
  }

  if (!isNqAddress(address) && !body.demo)
    throw new HttpError(400, 'Invalid Nimiq address')

  const token = nanoid(40)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  db.prepare('INSERT INTO auth_sessions (token_hash, address, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    address,
    expiresAt,
  )
  return { token, address, expiresAt }
}

export function requireSession(authorization: string | undefined): { address: string } {
  pruneExpired()
  const raw = authorization?.trim() || ''
  const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : ''
  if (!token)
    throw new HttpError(401, 'Sign in with your wallet to open inbox')
  const row = db.prepare(
    'SELECT address, expires_at FROM auth_sessions WHERE token_hash = ?',
  ).get(hashToken(token)) as { address: string, expires_at: string } | undefined
  if (!row || row.expires_at < new Date().toISOString())
    throw new HttpError(401, 'Session expired — connect again')
  return { address: row.address }
}
