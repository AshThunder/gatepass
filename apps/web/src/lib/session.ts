import { api } from '@/api/client'
import { connectNimiq, isDemoAllowed, signMessage } from '@/nimiq/wallet'
import type { AuthSessionResponse } from '@gatepass/shared'

const KEY = 'gatepass:inboxSession'

function sameAddress(a: string, b: string) {
  return a.replace(/\s+/g, '').toUpperCase() === b.replace(/\s+/g, '').toUpperCase()
}

let inflight: Promise<AuthSessionResponse> | null = null
let inflightAddress = ''

export function readSession(): AuthSessionResponse | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw)
      return null
    const session = JSON.parse(raw) as AuthSessionResponse
    if (!session.token || !session.address)
      return null
    if (session.expiresAt && +new Date(session.expiresAt) < Date.now()) {
      localStorage.removeItem(KEY)
      return null
    }
    return session
  }
  catch {
    return null
  }
}

function persist(session: AuthSessionResponse) {
  localStorage.setItem(KEY, JSON.stringify(session))
}

export function clearSession() {
  localStorage.removeItem(KEY)
}

async function createInboxSession(address: string): Promise<AuthSessionResponse> {
  const { nonce } = await api.authChallenge()
  try {
    const provider = await connectNimiq()
    const signed = await signMessage(provider, nonce)
    const session = await api.authSession({
      nonce,
      address,
      publicKey: signed.publicKey,
      signature: signed.signature,
    })
    persist(session)
    return session
  }
  catch (err) {
    if (!isDemoAllowed())
      throw err
    const net = await api.network()
    if (!net.skipTxVerify)
      throw err
    const session = await api.authSession({ nonce, address, demo: true })
    persist(session)
    return session
  }
}

export async function ensureInboxSession(address: string): Promise<AuthSessionResponse> {
  const existing = readSession()
  if (existing && sameAddress(existing.address, address))
    return existing

  if (inflight && sameAddress(inflightAddress, address))
    return inflight

  inflightAddress = address
  inflight = createInboxSession(address).finally(() => {
    inflight = null
    inflightAddress = ''
  })
  return inflight
}

export async function demoInboxSession(address: string): Promise<AuthSessionResponse> {
  if (!isDemoAllowed())
    throw new Error('Demo inbox is off')
  const net = await api.network()
  if (!net.skipTxVerify)
    throw new Error('Demo inbox needs SKIP_TX_VERIFY on the API')
  const { nonce } = await api.authChallenge()
  const session = await api.authSession({ nonce, address, demo: true })
  persist(session)
  return session
}
