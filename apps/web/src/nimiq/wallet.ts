import { init, type NimiqProvider } from '@nimiq/mini-app-sdk'
import { paymentMemo } from '@gatepass/shared'

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

let providerPromise: Promise<NimiqProvider> | null = null

export function getProviderErrorMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('error' in value))
    return null
  const maybeError = (value as { error?: { message?: unknown, type?: unknown } }).error
  if (maybeError && typeof maybeError.message === 'string') {
    const type = typeof maybeError.type === 'string' ? maybeError.type : ''
    if (type === 'PermissionDeniedError' || /denied|reject/i.test(maybeError.message))
      return 'Payment cancelled in Nimiq Pay'
    return maybeError.message
  }
  return 'Provider request failed.'
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
  return result as string[]
}

export async function ensureConsensus(provider: NimiqProvider): Promise<void> {
  const ready = await provider.isConsensusEstablished()
  if (!ready)
    throw new Error('Nimiq Pay has not established consensus yet — wait a moment and retry')
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

  let validityStartHeight: number | undefined
  try {
    const height = await provider.getBlockNumber()
    if (typeof height === 'number' && Number.isFinite(height))
      validityStartHeight = height
  }
  catch {
    // optional
  }

  const payload: {
    recipient: string
    value: number
    data: string
    validityStartHeight?: number
  } = {
    recipient: opts.recipient,
    value,
    data: paymentMemo(opts.eventId, quantity),
  }
  if (validityStartHeight != null)
    payload.validityStartHeight = validityStartHeight

  const result = await provider.sendBasicTransactionWithData(payload)
  const err = getProviderErrorMessage(result)
  if (err)
    throw new Error(err)
  if (typeof result !== 'string' || !result.trim())
    throw new Error('Nimiq Pay did not return a transaction hash')
  return result.trim()
}

export function isDemoAllowed(): boolean {
  return import.meta.env.VITE_ALLOW_DEMO === 'true'
}
