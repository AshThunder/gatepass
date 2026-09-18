import { ref } from 'vue'
import { api } from '@/api/client'
import type { EventRecord, HallInfo } from '@gatepass/shared'

/** Shared live event + hall list. Discover, Host, and Gate all read this. */
export const events = ref<EventRecord[]>([])
export const hall = ref<HallInfo | null>(null)
export const loading = ref(true)
export const error = ref('')

const POLL_MS = 12_000
let inflight: Promise<void> | null = null
let started = false
let pollTimer: ReturnType<typeof setInterval> | null = null
let canReload = () => true
const bootStamp = hashedAssets(document.documentElement.innerHTML)

export function setCanReload(fn: () => boolean) {
  canReload = fn
}

export async function refreshCatalog() {
  if (inflight)
    return inflight
  inflight = (async () => {
    const first = events.value.length === 0
    if (first)
      loading.value = true
    try {
      const [list, hallInfo] = await Promise.all([
        api.listEvents(),
        api.getHall().catch(() => null),
      ])
      events.value = list.events
      if (hallInfo)
        hall.value = hallInfo
      error.value = ''
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
    finally {
      loading.value = false
      inflight = null
    }
  })()
  return inflight
}

function onWake() {
  if (document.visibilityState === 'hidden')
    return
  void refreshCatalog()
  void checkAppRevision()
}

export function startCatalogSync() {
  if (started)
    return
  started = true
  void refreshCatalog()
  void checkAppRevision()
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden')
      return
    void refreshCatalog()
    void checkAppRevision()
  }, POLL_MS)
  document.addEventListener('visibilitychange', onWake)
  window.addEventListener('focus', onWake)
  window.addEventListener('pageshow', onWake)
}

function hashedAssets(html: string) {
  return [...html.matchAll(/src="([^"]*\/assets\/[^"]+\.js)"/g)].map(m => m[1]).sort().join('|')
}

async function checkAppRevision() {
  if (!canReload() || !bootStamp)
    return
  try {
    const res = await fetch(`${window.location.pathname || '/'}`, {
      cache: 'no-store',
      headers: { accept: 'text/html' },
    })
    if (!res.ok)
      return
    const html = await res.text()
    const next = hashedAssets(html)
    if (next && next !== bootStamp)
      window.location.reload()
  }
  catch { /* offline / API-only */ }
}
