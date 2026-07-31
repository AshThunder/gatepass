/**
 * Nimiq Albatross RPC helpers for verifying GATEPASS ticket payments.
 *
 * Public history nodes (e.g. https://rpc.nimiqwatch.com) wrap results as
 * `{ data: T, metadata: null }`. We unwrap that and poll until the tx is
 * indexed with enough confirmations.
 *
 * Env:
 * - NIMIQ_NETWORK=mainnet|testnet (default: mainnet)
 * - NIMIQ_RPC_URL=override RPC base (defaults per network)
 * - NIMIQ_MIN_CONFIRMATIONS=1 (default)
 * - NIMIQ_TX_WAIT_MS=45000 (default poll timeout)
 * - SKIP_TX_VERIFY=true — allow demo purchases only when client sends demo:true
 */

export interface VerifiedPayment {
  hash: string
  recipient: string
  sender?: string
  value: number
  data: string
  confirmations: number
  blockNumber?: number
  networkId?: number
  executionResult: boolean
}

export type NimiqNetwork = 'mainnet' | 'testnet'

/** MainAlbatross network id observed on public RPC */
const MAINNET_NETWORK_ID = 24

const NETWORK_RPC: Record<NimiqNetwork, string> = {
  mainnet: 'https://rpc.nimiqwatch.com',
  // No public default — set NIMIQ_RPC_URL to a test-albatross history node.
  testnet: '',
}

export function getNetwork(): NimiqNetwork {
  const raw = (process.env.NIMIQ_NETWORK || 'mainnet').toLowerCase()
  return raw === 'testnet' ? 'testnet' : 'mainnet'
}

export function getRpcUrl(): string {
  const override = process.env.NIMIQ_RPC_URL?.trim()
  if (override)
    return override
  const fallback = NETWORK_RPC[getNetwork()]
  if (!fallback) {
    throw new Error(
      'NIMIQ_RPC_URL is required when NIMIQ_NETWORK=testnet (no public testnet RPC default)',
    )
  }
  return fallback
}

export function minConfirmations(): number {
  const n = Number(process.env.NIMIQ_MIN_CONFIRMATIONS ?? '1')
  return Number.isFinite(n) && n >= 0 ? n : 1
}

export function txWaitMs(): number {
  const n = Number(process.env.NIMIQ_TX_WAIT_MS ?? '45000')
  return Number.isFinite(n) && n > 0 ? n : 45_000
}

function normalizeAddress(addr: string): string {
  return addr.replace(/\s+/g, '').toUpperCase()
}

function unwrapResult(result: unknown): unknown {
  if (result && typeof result === 'object' && 'data' in result) {
    return (result as { data: unknown }).data
  }
  return result
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(getRpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok)
    throw new Error(`RPC HTTP ${res.status} from ${getRpcUrl()}`)
  const body = await res.json() as {
    result?: unknown
    error?: { message?: string, data?: unknown }
  }
  if (body.error) {
    const detail = body.error.data ? `: ${String(body.error.data)}` : ''
    throw new Error((body.error.message || 'RPC error') + detail)
  }
  return unwrapResult(body.result)
}

function extractTx(raw: unknown): VerifiedPayment | null {
  if (!raw || typeof raw !== 'object')
    return null
  const tx = raw as Record<string, unknown>

  const hash = String(tx.hash ?? tx.transactionHash ?? tx.txHash ?? '')
  const recipient = String(tx.to ?? tx.recipient ?? tx.recipientAddress ?? '')
  const value = Number(tx.value ?? tx.amount ?? 0)
  const data = String(
    tx.recipientData ?? tx.data ?? tx.memo ?? tx.message ?? '',
  )
  const sender = tx.from
    ? String(tx.from)
    : tx.sender
      ? String(tx.sender)
      : undefined
  const confirmations = Number(tx.confirmations ?? 0)
  const blockNumber = tx.blockNumber != null ? Number(tx.blockNumber) : undefined
  const networkId = tx.networkId != null ? Number(tx.networkId) : undefined
  const executionResult = tx.executionResult === undefined
    ? true
    : Boolean(tx.executionResult)

  if (!hash || !recipient)
    return null

  return {
    hash,
    recipient,
    sender,
    value,
    data,
    confirmations: Number.isFinite(confirmations) ? confirmations : 0,
    blockNumber,
    networkId,
    executionResult,
  }
}

export async function getBlockNumber(): Promise<number | null> {
  try {
    const result = await rpcCall('getBlockNumber', [])
    const n = Number(result)
    return Number.isFinite(n) ? n : null
  }
  catch {
    return null
  }
}

export async function getTransaction(txHash: string): Promise<VerifiedPayment | null> {
  const clean = txHash.replace(/^0x/i, '').trim()
  try {
    const result = await rpcCall('getTransactionByHash', [clean])
    return extractTx(result)
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not found/i.test(msg))
      return null
    throw err
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Poll until the tx is indexed with enough confirmations (or timeout).
 */
export async function waitForTransaction(
  txHash: string,
  opts?: { minConfirmations?: number, timeoutMs?: number, intervalMs?: number },
): Promise<VerifiedPayment> {
  const need = opts?.minConfirmations ?? minConfirmations()
  const timeoutMs = opts?.timeoutMs ?? txWaitMs()
  const intervalMs = opts?.intervalMs ?? 1500
  const start = Date.now()
  let lastError: Error | null = null

  while (Date.now() - start < timeoutMs) {
    try {
      const tx = await getTransaction(txHash)
      if (tx && tx.confirmations >= need)
        return tx
    }
    catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
    await sleep(intervalMs)
  }

  if (lastError)
    throw new Error(`Timed out waiting for tx ${txHash}: ${lastError.message}`)
  throw new Error(`Timed out waiting for tx ${txHash} to reach ${need} confirmation(s)`)
}

export function addressesMatch(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b)
}

export function dataContainsMemo(data: string, memo: string): boolean {
  if (!data)
    return false
  if (data.includes(memo))
    return true
  try {
    const hex = data.replace(/^0x/i, '')
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
      const decoded = Buffer.from(hex, 'hex').toString('utf8')
      if (decoded.includes(memo))
        return true
    }
  }
  catch {
    // ignore
  }
  return false
}

export function allowSkipVerify(): boolean {
  return process.env.SKIP_TX_VERIFY === 'true' || process.env.SKIP_TX_VERIFY === '1'
}

export function assertPaymentMatches(opts: {
  tx: VerifiedPayment
  organizerAddress: string
  buyerAddress: string
  priceLuna: number
  memo: string
}): void {
  const { tx, organizerAddress, priceLuna, memo } = opts

  if (!tx.executionResult)
    throw new Error('Payment failed on-chain (executionResult=false)')

  if (!addressesMatch(tx.recipient, organizerAddress))
    throw new Error('Payment recipient does not match organizer')

  // Do not hard-require client buyerAddress === tx.sender.
  // Nimiq Pay may sign from a different account than listAccounts()[0]
  // (multi-account wallets, fromType ≠ basic). The on-chain sender is source of truth.

  if (tx.value < priceLuna)
    throw new Error(`Insufficient payment: got ${tx.value} Luna, need ${priceLuna}`)

  if (!dataContainsMemo(tx.data, memo))
    throw new Error(`Payment memo must include ${memo}`)

  if (getNetwork() === 'mainnet' && tx.networkId != null && tx.networkId !== MAINNET_NETWORK_ID) {
    throw new Error(`Unexpected networkId ${tx.networkId} (expected mainnet ${MAINNET_NETWORK_ID})`)
  }
}

export async function getNetworkStatus() {
  const network = getNetwork()
  const rpcUrl = getRpcUrl()
  const blockNumber = await getBlockNumber()
  return {
    network,
    rpcUrl,
    blockNumber,
    minConfirmations: minConfirmations(),
    skipTxVerify: allowSkipVerify(),
    reachable: blockNumber != null,
  }
}
