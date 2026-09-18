import { computed, ref } from 'vue'
import {
  connectNimiq,
  listAccounts,
  PROVIDER_CONNECT_MS,
  tryConnectNimiq,
  type NimiqProvider,
} from '@/nimiq/wallet'

const address = ref('')
const ready = ref(false)
const busy = ref(false)
let probePromise: Promise<void> | null = null

function shortLabel(addr: string) {
  const clean = addr.replace(/\s+/g, '')
  if (clean.length > 10)
    return `${clean.slice(0, 4)}…${clean.slice(-4)}`
  return addr ? 'Connected' : 'Connect'
}

const label = computed(() => (ready.value && address.value ? shortLabel(address.value) : 'Connect'))

async function applyProvider(provider: NimiqProvider) {
  const accounts = await listAccounts(provider)
  address.value = accounts[0] || ''
  ready.value = !!address.value
}

/** Silent boot probe — never flips busy / disables the header. */
export async function probeWallet() {
  if (ready.value)
    return
  if (!probePromise) {
    probePromise = (async () => {
      const provider = await tryConnectNimiq()
      if (!provider)
        return
      try {
        await applyProvider(provider)
      }
      catch {
        ready.value = false
      }
    })().finally(() => {
      if (!ready.value)
        probePromise = null
    })
  }
  return probePromise
}

export async function connectWallet() {
  if (busy.value)
    return null
  busy.value = true
  try {
    const provider = await connectNimiq(PROVIDER_CONNECT_MS)
    await applyProvider(provider)
    return provider
  }
  catch {
    ready.value = false
    address.value = ''
    return null
  }
  finally {
    busy.value = false
  }
}

export function useWallet() {
  return {
    address,
    ready,
    busy,
    label,
    probe: probeWallet,
    connect: connectWallet,
  }
}
