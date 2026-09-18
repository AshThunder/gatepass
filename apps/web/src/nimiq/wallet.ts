import { init, type NimiqProvider } from '@nimiq/mini-app-sdk'
import { hallRentMemo, paymentMemo } from '@gatepass/shared'
import { api } from '@/api/client'

export type { NimiqProvider }

declare global {
  interface Window {
    nimiq?: NimiqProvider
  }
}

/** Inside Nimiq Pay the provider is injected before page JS runs. */
export const PROVIDER_PROBE_MS = 1_500
/** Manual Connect: still short — if it isn't there, waiting longer does not help. */
export const PROVIDER_CONNECT_MS = 3_000
/** Light-client sync on mobile can take several seconds after the Mini App opens. */
export const CONSENSUS_WAIT_MS = 20_000
const CONSENSUS_POLL_MS = 500

let providerPromise: Promise<NimiqProvider> | null = null

export function getProviderErrorMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null)
    return null
  const rec = value as { error?: { message?: unknown, type?: unknown }, message?: unknown }
  const nested = rec.error
  const raw = (nested && typeof nested.message === 'string' && nested.message)
    || (typeof rec.message === 'string' && rec.message)
    || ''
  if (!raw)
    return nested ? 'Provider request failed.' : null
  const type = nested && typeof nested.type === 'string' ? nested.type : ''
  if (type === 'PermissionDeniedError' || /denied|reject/i.test(raw))
    return 'Payment cancelled in Nimiq Pay'
  return friendlyPayError(raw)
}

export function toErrorMessage(value: unknown): string {
  if (typeof value === 'string' && value.trim() && value !== '[object Object]')
    return friendlyPayError(value)
  if (value instanceof Error) {
    if (value.message && value.message !== '[object Object]')
      return friendlyPayError(value.message)
    if ('cause' in value && value.cause !== undefined)
      return toErrorMessage(value.cause)
  }
  const fromProvider = getProviderErrorMessage(value)
  if (fromProvider)
    return fromProvider
  return 'Something went wrong. Try again.'
}

function friendlyPayError(message: string): string {
  if (/validity end/i.test(message))
    return 'Nimiq Pay’s transaction window expired. Close this and pay again.'
  return message
}

/** Current Provider API returns a bare hash string; older hosts used `{ hash }` or `{ error }`. */
export function txHashFromResult(result: unknown): string {
  if (typeof result === 'string' && result.trim())
    return result.trim()
  const err = getProviderErrorMessage(result)
  if (err)
    throw new Error(err)
  if (typeof result === 'object' && result !== null && 'hash' in result) {
    const hash = (result as { hash?: unknown }).hash
    if (typeof hash === 'string' && hash.trim())
      return hash.trim()
  }
  throw new Error('No transaction hash returned from Nimiq Pay')
}

export async function signMessage(
  provider: NimiqProvider,
  message: string,
): Promise<{ publicKey: string, signature: string }> {
  const result = await provider.sign(message)
  const err = getProviderErrorMessage(result)
  if (err)
    throw new Error(err)
  if (typeof result === 'object' && result !== null) {
    const publicKey = (result as { publicKey?: unknown }).publicKey
    const signature = (result as { signature?: unknown }).signature
    if (typeof publicKey === 'string' && typeof signature === 'string' && publicKey && signature)
      return { publicKey, signature }
  }
  throw new Error('Wallet did not return a signature')
}

export function hasNimiqProvider(): boolean {
  return typeof window !== 'undefined' && !!window.nimiq
}

export function getNimiqProvider(): NimiqProvider | null {
  return hasNimiqProvider() ? window.nimiq! : null
}

/**
 * Resolve the injected Nimiq Pay provider.
 * Instant when `window.nimiq` already exists; otherwise waits up to `timeout` ms.
 */
export async function connectNimiq(timeout = PROVIDER_CONNECT_MS): Promise<NimiqProvider> {
  const existing = getNimiqProvider()
  if (existing)
    return existing

  if (!providerPromise) {
    providerPromise = init({ timeout }).catch((err) => {
      providerPromise = null
      throw err
    })
  }
  return providerPromise
}

/** Non-blocking probe for auto-connect (no long hang outside Nimiq Pay). */
export async function tryConnectNimiq(timeout = PROVIDER_PROBE_MS): Promise<NimiqProvider | null> {
  try {
    return await connectNimiq(timeout)
  }
  catch {
    return null
  }
}

export async function listAccounts(provider: NimiqProvider): Promise<string[]> {
  const result = await provider.listAccounts()
  const err = getProviderErrorMessage(result)
  if (err)
    throw new Error(err)
  if (!Array.isArray(result))
    throw new Error('No Nimiq accounts returned')
  return result.filter((a): a is string => typeof a === 'string' && !!a)
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function isConsensusTrue(value: unknown): boolean {
  return value === true || value === 1 || value === 'true'
}

export async function ensureConsensus(provider: NimiqProvider): Promise<void> {
  const deadline = Date.now() + CONSENSUS_WAIT_MS
  let lastErr = ''

  while (Date.now() < deadline) {
    try {
      const ready = await provider.isConsensusEstablished()
      const err = getProviderErrorMessage(ready)
      if (err)
        lastErr = err
      else if (isConsensusTrue(ready))
        return
    }
    catch (err) {
      lastErr = toErrorMessage(err)
    }

    await sleep(CONSENSUS_POLL_MS)
  }

  throw new Error(lastErr || 'Nimiq Pay is still syncing. Wait a few seconds and try again.')
}

function asPositiveHeight(value: unknown): number | null {
  if (getProviderErrorMessage(value))
    return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

async function readPayHeight(provider: NimiqProvider): Promise<number | null> {
  try {
    return asPositiveHeight(await provider.getBlockNumber())
  }
  catch {
    return null
  }
}

async function readRpcHeight(): Promise<number | null> {
  try {
    return asPositiveHeight((await api.network()).blockNumber)
  }
  catch {
    return null
  }
}

/** Albatross txs expire 120 blocks after validityStartHeight (~2 min). A missing/stale height looks expired. */
async function resolveValidityStartHeight(provider: NimiqProvider): Promise<number> {
  const [payHeight, rpcHeight] = await Promise.all([readPayHeight(provider), readRpcHeight()])
  const height = Math.max(payHeight ?? 0, rpcHeight ?? 0)
  if (height > 0)
    return height
  throw new Error('Could not read the current Nimiq block height. Try again in a moment.')
}

export async function payForTicket(
  provider: NimiqProvider,
  opts: {
    recipient: string
    eventId: string
    /** Unit price — used when totalLuna omitted */
    priceLuna?: number
    quantity?: number
    /** Exact cart total in Luna (preferred for multi-tier) */
    totalLuna?: number
  },
): Promise<string> {
  await ensureConsensus(provider)
  const quantity = Math.max(1, opts.quantity ?? 1)
  const value = opts.totalLuna ?? ((opts.priceLuna ?? 0) * quantity)

  return sendPayment(provider, {
    recipient: opts.recipient,
    value,
    data: paymentMemo(opts.eventId, quantity),
  })
}

export async function payForHallRent(
  provider: NimiqProvider,
  opts: {
    recipient: string
    slotId: string
    rentLuna: number
  },
): Promise<string> {
  await ensureConsensus(provider)
  return sendPayment(provider, {
    recipient: opts.recipient,
    value: opts.rentLuna,
    data: hallRentMemo(opts.slotId),
  })
}

async function sendPayment(
  provider: NimiqProvider,
  payload: { recipient: string, value: number, data: string },
): Promise<string> {
  const validityStartHeight = await resolveValidityStartHeight(provider)
  try {
    const result = await provider.sendBasicTransactionWithData({
      ...payload,
      validityStartHeight,
    })
    return txHashFromResult(result)
  }
  catch (err) {
    throw new Error(toErrorMessage(err))
  }
}

export function isDemoAllowed(): boolean {
  return import.meta.env.VITE_ALLOW_DEMO === 'true'
}
