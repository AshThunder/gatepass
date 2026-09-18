<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Html5Qrcode } from 'html5-qrcode'
import { api } from '@/api/client'
import {
  decodeGateUnlock,
  decodeQrPayload,
  decodeStaffUnlock,
  verifyTotp,
} from '@/crypto/ticket'
import type { EventRecord, GateBundle } from '@gatepass/shared'
import FlashBanner from '@/components/FlashBanner.vue'
import GateStepper from '@/components/GateStepper.vue'

const STORAGE_KEY = 'gatepass:gateBundle'
const QUEUE_KEY = 'gatepass:redeemQueue'
const TABLET_KEY = 'gatepass:gateTablet'
const AUTO_MS = 45_000

type Mode = 'unlock' | 'scan'

const props = defineProps<{
  pendingUnlock?: {
    eventId: string
    token: string
    secret?: string
  } | null
}>()

const emit = defineEmits<{
  unlockConsumed: []
}>()

const mode = ref<Mode>('unlock')
const unlocked = ref(false)
const bundle = ref<GateBundle | null>(null)
const unlockInput = ref('')
const ticketInput = ref('')
const message = ref('')
const error = ref('')
const lastResult = ref<'ok' | 'fail' | null>(null)
const scanning = ref(false)
const pendingCount = ref(0)
const cameraHint = ref('')
const lastSyncedLabel = ref('')
const events = ref<EventRecord[]>([])
const staffEventId = ref('')
const staffPass = ref('')
const tabletMode = ref(localStorage.getItem(TABLET_KEY) === '1')
let scanner: Html5Qrcode | null = null
let handling = false
let autoTimer: ReturnType<typeof setInterval> | null = null
let wakeLock: WakeLockSentinel | null = null

const gateSteps = [
  { title: 'Event' },
  { title: 'PIN' },
  { title: 'Unlock' },
  { title: 'Scan' },
]

const gateStep = computed(() => {
  if (unlocked.value)
    return 3
  if (staffPass.value.trim() && staffEventId.value)
    return 2
  if (staffEventId.value)
    return 1
  return 0
})

const validCached = computed(() =>
  bundle.value?.tickets.filter(t => t.status === 'valid').length || 0,
)
const staffEvents = computed(() =>
  events.value.filter(e => e.hasStaffPasscode && Date.now() <= new Date(e.endsAt).getTime() + 6 * 3600_000),
)

function eventWhen(ev: EventRecord) {
  return new Date(ev.startsAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function toggleTablet() {
  tabletMode.value = !tabletMode.value
  localStorage.setItem(TABLET_KEY, tabletMode.value ? '1' : '0')
  void manageWakeLock()
}

async function manageWakeLock() {
  try {
    if (tabletMode.value && unlocked.value && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen')
    }
    else if (wakeLock) {
      await wakeLock.release()
      wakeLock = null
    }
  }
  catch { /* unsupported */ }
}

function refreshCameraCapability() {
  const hasMedia = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
  const secure = typeof window !== 'undefined'
    && (window.isSecureContext || ['localhost', '127.0.0.1'].includes(window.location.hostname))

  if (!hasMedia) {
    cameraHint.value = 'No camera API — paste codes instead.'
  }
  else if (!secure) {
    cameraHint.value = 'Camera usually needs HTTPS. Paste works on plain http://.'
  }
  else {
    cameraHint.value = ''
  }
}

interface QueueItem {
  ticketId: string
  totp: string
  at: number
}

function loadQueue(): QueueItem[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') as QueueItem[]
  }
  catch {
    return []
  }
}

function saveQueue(items: QueueItem[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items))
  pendingCount.value = items.length
}

function updateSyncLabel(iso?: string) {
  lastSyncedLabel.value = iso ? new Date(iso).toLocaleTimeString() : ''
}

function restoreBundle() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw)
    return
  try {
    bundle.value = JSON.parse(raw) as GateBundle
    unlocked.value = true
    mode.value = 'scan'
    updateSyncLabel(bundle.value.syncedAt)
  }
  catch { /* ignore */ }
}

async function applyBundle(data: GateBundle, unlockToken?: string, masterSecret?: string) {
  bundle.value = data
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  unlocked.value = true
  mode.value = 'scan'
  updateSyncLabel(data.syncedAt)
  message.value = `Unlocked · ${data.eventTitle} — ready to scan`
  error.value = ''
  lastResult.value = null
  if (unlockToken) {
    localStorage.setItem(`gatepass:event:${data.eventId}:master`, JSON.stringify({
      eventMasterSecret: masterSecret || data.eventMasterSecret,
      gateUnlockToken: unlockToken,
    }))
  }
  void manageWakeLock()
  void startScan()
}

async function unlockFromPayload(raw: string) {
  const staff = decodeStaffUnlock(raw)
  if (staff) {
    const res = await api.staffUnlock(staff.eventId, staff.passcode)
    await applyBundle(res.bundle, res.gateUnlockToken, res.eventMasterSecret)
    return
  }
  const parsed = decodeGateUnlock(raw)
  if (!parsed) {
    if (raw.trim().startsWith('GP1:'))
      throw new Error('That’s a guest ticket. Unlock from My events, or type the door PIN.')
    throw new Error('Unlock from My events, or type the door PIN.')
  }
  const data = await api.gateBundle(parsed.eventId, parsed.unlockToken)
  await applyBundle(data, parsed.unlockToken, parsed.masterSecret)
}

async function unlockManual() {
  error.value = ''
  message.value = ''
  const raw = unlockInput.value.trim()
  if (!raw) {
    error.value = 'Paste the unlock code, or type the door PIN.'
    return
  }
  try {
    if (
      raw.startsWith('GPGATE:')
      || raw.startsWith('GPSTAFF:')
      || raw.replace(/\s+/g, '').startsWith('GPGATE:')
      || raw.replace(/\s+/g, '').startsWith('GPSTAFF:')
    ) {
      await unlockFromPayload(raw)
      return
    }
    if (raw.startsWith('GP1:')) {
      error.value = 'That’s a guest ticket. Unlock from My events, or type the door PIN.'
      return
    }
    const [eventId, token] = raw.split('|').map(s => s.trim())
    if (eventId && token) {
      const data = await api.gateBundle(eventId, token)
      await applyBundle(data, token)
      return
    }
    error.value = 'Paste the unlock code, or type the door PIN.'
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function unlockWithStaffPass() {
  error.value = ''
  message.value = ''
  if (!staffEventId.value) {
    error.value = 'Pick an event'
    return
  }
  if (!staffPass.value.trim()) {
    error.value = 'Enter the door PIN'
    return
  }
  try {
    const res = await api.staffUnlock(staffEventId.value, staffPass.value.trim())
    await applyBundle(res.bundle, res.gateUnlockToken, res.eventMasterSecret)
    staffPass.value = ''
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function consumePendingUnlock() {
  const pending = props.pendingUnlock
  if (!pending?.eventId || !pending.token)
    return false
  error.value = ''
  try {
    const data = await api.gateBundle(pending.eventId, pending.token)
    await applyBundle(data, pending.token, pending.secret)
    emit('unlockConsumed')
    return true
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    emit('unlockConsumed')
    return false
  }
}

async function refreshBundle() {
  if (!bundle.value)
    return
  const stored = localStorage.getItem(`gatepass:event:${bundle.value.eventId}:master`)
  let token = ''
  if (stored) {
    try {
      token = (JSON.parse(stored) as { gateUnlockToken: string }).gateUnlockToken
    }
    catch { /* ignore */ }
  }
  if (!token)
    return
  const data = await api.gateBundle(bundle.value.eventId, token)
  bundle.value = data
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  updateSyncLabel(data.syncedAt)
  message.value = `Synced ${data.tickets.length} ticket(s)`
}

async function syncQueue() {
  const queue = loadQueue()
  if (!queue.length)
    return
  const remaining: QueueItem[] = []
  for (const item of queue) {
    try {
      await api.redeem(item.ticketId, item.totp)
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already redeemed') || msg.includes('cancelled'))
        continue
      remaining.push(item)
    }
  }
  saveQueue(remaining)
  await refreshBundle().catch(() => {})
}

async function handleScan(raw: string) {
  if (handling)
    return
  handling = true
  error.value = ''
  message.value = ''
  lastResult.value = null
  try {
    const cleaned = raw.trim()

    if (
      mode.value === 'unlock'
      || cleaned.startsWith('GPGATE:')
      || cleaned.startsWith('GPSTAFF:')
    ) {
      if (
        cleaned.startsWith('GPGATE:')
        || cleaned.startsWith('GPSTAFF:')
        || cleaned.replace(/\s+/g, '').startsWith('GPGATE:')
        || cleaned.replace(/\s+/g, '').startsWith('GPSTAFF:')
      ) {
        await unlockFromPayload(cleaned)
        return
      }
      if (mode.value === 'unlock') {
        if (cleaned.startsWith('GP1:') || cleaned.replace(/\s+/g, '').startsWith('GP1:'))
          throw new Error('That’s a guest ticket. Unlock from My events, or type the door PIN.')
        throw new Error('Unlock from My events, or type the door PIN.')
      }
    }

    if (!bundle.value || !unlocked.value)
      throw new Error('Unlock first, then scan guest tickets')

    if (mode.value !== 'scan')
      throw new Error('Switch to Scan tickets mode')

    const payload = decodeQrPayload(cleaned)
    if (!payload)
      throw new Error('Not a GatePass ticket QR')
    if (payload.eventId !== bundle.value.eventId)
      throw new Error('Ticket is for a different event')

    const ticket = bundle.value.tickets.find(t => t.id === payload.ticketId)
    if (!ticket)
      throw new Error('Unknown ticket — tap Refresh')

    if (ticket.status === 'cancelled')
      throw new Error('Ticket cancelled — DENY')
    if (ticket.status === 'redeemed')
      throw new Error('Already redeemed')

    const ok = await verifyTotp(ticket.ticketSeed, payload.totp)
    if (!ok)
      throw new Error('Invalid / expired code')

    ticket.status = 'redeemed'
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle.value))
    const queue = loadQueue()
    queue.push({ ticketId: payload.ticketId, totp: payload.totp, at: Date.now() })
    saveQueue(queue)
    lastResult.value = 'ok'
    message.value = `Checked in ${payload.ticketId.slice(0, 8)}…`
    void syncQueue()
  }
  catch (err) {
    lastResult.value = 'fail'
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    setTimeout(() => {
      handling = false
    }, 1200)
    setTimeout(() => {
      lastResult.value = null
    }, 2800)
  }
}

async function startScan() {
  error.value = ''
  refreshCameraCapability()
  if (scanning.value)
    return
  if (!navigator.mediaDevices?.getUserMedia) {
    error.value = 'No camera — paste instead.'
    return
  }
  scanning.value = true
  scanner = new Html5Qrcode('gate-reader')
  try {
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 8, qrbox: { width: 240, height: 240 } },
        decoded => void handleScan(decoded),
        () => {},
      )
    }
    catch {
      const cameras = await Html5Qrcode.getCameras()
      if (!cameras.length)
        throw new Error('No camera found')
      await scanner.start(
        cameras[0]!.id,
        { fps: 8, qrbox: { width: 240, height: 240 } },
        decoded => void handleScan(decoded),
        () => {},
      )
    }
  }
  catch (err) {
    scanning.value = false
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function submitTicketPaste() {
  const raw = ticketInput.value.trim()
  if (!raw) {
    error.value = 'Paste GP1:… ticket string'
    return
  }
  await handleScan(raw)
  if (lastResult.value === 'ok')
    ticketInput.value = ''
}

async function stopScan() {
  if (scanner) {
    try {
      await scanner.stop()
      await scanner.clear()
    }
    catch { /* ignore */ }
    scanner = null
  }
  scanning.value = false
}

function lockGate() {
  void stopScan()
  unlocked.value = false
  bundle.value = null
  mode.value = 'unlock'
  localStorage.removeItem(STORAGE_KEY)
  message.value = 'Gate locked'
}

watch(mode, (m) => {
  lastResult.value = null
  error.value = ''
  if (m === 'scan' && unlocked.value && !scanning.value)
    void startScan()
})

onMounted(async () => {
  const params = new URLSearchParams(window.location.search)
  if (params.get('tablet') === '1') {
    tabletMode.value = true
    localStorage.setItem(TABLET_KEY, '1')
  }
  refreshCameraCapability()
  const fromHost = await consumePendingUnlock()
  if (!fromHost) {
    restoreBundle()
    if (unlocked.value && mode.value === 'scan')
      void startScan()
  }
  pendingCount.value = loadQueue().length
  void syncQueue()
  void manageWakeLock()
  autoTimer = setInterval(() => {
    if (!unlocked.value || !bundle.value)
      return
    void refreshBundle().catch(() => {})
    void syncQueue()
  }, AUTO_MS)
  try {
    const res = await api.listEvents()
    events.value = res.events
    if (staffEvents.value.length === 1)
      staffEventId.value = staffEvents.value[0]!.id
  }
  catch { /* ignore */ }
})

onUnmounted(() => {
  void stopScan()
  if (autoTimer)
    clearInterval(autoTimer)
})
</script>

<template>
  <section :class="{ tablet: tabletMode }">
    <div class="gate-top">
      <div>
        <h1 class="gp-page-title">
          Gate
        </h1>
        <p class="gp-page-sub">
          {{ unlocked ? bundle?.eventTitle : 'Unlock, then scan tickets.' }}
        </p>
      </div>
      <button class="gp-btn ghost sm" type="button" style="width: auto; flex-shrink: 0;" @click="toggleTablet">
        {{ tabletMode ? 'Phone' : 'Tablet' }}
      </button>
    </div>

    <GateStepper :current="gateStep" :steps="gateSteps" />

    <template v-if="!unlocked">
      <div class="gp-card">
        <h2 class="gp-h2">
          Unlock
        </h2>
        <p class="gp-sub">
          Enter the door PIN, or tap Check in guests on My events.
        </p>
        <div id="gate-reader" class="gate-reader" />
        <p v-if="cameraHint" class="gp-banner" style="margin-top: 10px;">
          {{ cameraHint }}
        </p>
        <div class="gp-row" style="margin-top: 12px;">
          <button v-if="!scanning" class="gp-btn" type="button" @click="startScan">
            Start camera
          </button>
          <button v-else class="gp-btn danger" type="button" @click="stopScan">
            Pause
          </button>
        </div>

        <template v-if="staffEvents.length">
          <label class="gp-label">Event</label>
          <div class="gate-ev-list">
            <button
              v-for="ev in staffEvents"
              :key="ev.id"
              type="button"
              class="gate-ev"
              :class="{ on: staffEventId === ev.id }"
              @click="staffEventId = ev.id"
            >
              <strong>{{ ev.title }}</strong>
              <span>{{ eventWhen(ev) }} · {{ ev.venueName }}</span>
            </button>
          </div>
          <label class="gp-label">Door PIN</label>
          <input
            v-model="staffPass"
            class="gp-input"
            type="password"
            inputmode="numeric"
            autocomplete="off"
            placeholder="Door PIN"
          >
          <button
            class="gp-btn secondary sm"
            type="button"
            :disabled="!staffEventId"
            @click="unlockWithStaffPass"
          >
            Unlock
          </button>
        </template>

        <details class="gp-details" style="margin-top: 12px;">
          <summary>Can't scan?</summary>
          <label class="gp-label">Unlock code</label>
          <textarea v-model="unlockInput" class="gp-textarea" placeholder="Unlock code" />
          <button class="gp-btn secondary sm" type="button" @click="unlockManual">
            Unlock
          </button>
        </details>

        <FlashBanner
          v-if="error"
          :message="error"
          @clear="error = ''"
        />
      </div>
    </template>

    <template v-else>
      <div class="scan-shell">
        <p class="gp-sub" style="margin-bottom: 10px;">
          Now scan each guest’s ticket.
        </p>
        <div class="gp-chip-row">
          <span class="gp-pill ok">{{ scanning ? 'Live' : 'Ready' }}</span>
          <span class="gp-pill">{{ validCached }} left</span>
          <span v-if="pendingCount" class="gp-pill warn">{{ pendingCount }} queued</span>
        </div>
        <div id="gate-reader" class="gate-reader tall" />
        <div v-if="lastResult" class="gate-result" :class="lastResult">
          {{ lastResult === 'ok' ? 'ACCEPT' : 'DENY' }}
        </div>
        <FlashBanner
          v-if="message"
          kind="success"
          :message="message"
          @clear="message = ''"
        />
        <FlashBanner
          v-if="error"
          :message="error"
          @clear="error = ''"
        />
        <div class="gp-row" style="margin-top: 12px;">
          <button v-if="!scanning" class="gp-btn" type="button" @click="startScan">
            Resume camera
          </button>
          <button v-else class="gp-btn danger" type="button" @click="stopScan">
            Pause
          </button>
          <button class="gp-btn ghost sm" type="button" @click="refreshBundle">
            Refresh
          </button>
          <button class="gp-btn ghost sm" type="button" @click="lockGate">
            Lock
          </button>
        </div>
        <details class="gp-details" style="margin-top: 12px;">
          <summary>Can't scan ticket?</summary>
          <textarea v-model="ticketInput" class="gp-textarea" placeholder="Paste ticket code" />
          <button class="gp-btn secondary sm" type="button" @click="submitTicketPaste">
            Check in
          </button>
        </details>
      </div>
    </template>
  </section>
</template>

<style scoped>
.gate-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.gate-ev-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 12px;
}
.gate-ev {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--gp-border);
  border-radius: 16px;
  padding: 12px 14px;
  background: #fff;
  color: var(--gp-navy);
}
.gate-ev strong {
  font-size: 0.95rem;
  font-weight: 500;
}
.gate-ev span {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--gp-muted);
}
.gate-ev.on {
  border-color: var(--gp-gold);
  background: rgba(233, 178, 19, 0.14);
}
.scan-shell {
  margin: 0 -16px;
  padding: 0;
}
.scan-shell .gp-chip-row,
.scan-shell .gate-result,
.scan-shell .gp-row,
.scan-shell .gp-details,
.scan-shell .gp-sub {
  margin-left: 16px;
  margin-right: 16px;
}
.gate-reader {
  width: 100%;
  overflow: hidden;
  border-radius: 16px;
  min-height: 0;
  background: transparent;
}
.gate-reader.tall {
  min-height: 280px;
  border-radius: 0;
  width: 100%;
  margin: 0;
  background: #111318;
}
.gate-result {
  margin-top: 14px;
  text-align: center;
  font-weight: 500;
  font-size: 2rem;
  letter-spacing: 0.08em;
  padding: 22px;
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  animation: gp-fade-in 220ms var(--gp-ease);
}
.gate-result.ok {
  background: rgba(33, 188, 165, 0.16);
  color: #0f7a6b;
}
.gate-result.fail {
  background: rgba(217, 68, 79, 0.14);
  color: var(--gp-danger);
}
.tablet .gp-page-title {
  font-size: 1.75rem;
}
.tablet .gate-result {
  font-size: 2.2rem;
  padding: 28px;
}
.tablet .gp-btn {
  min-height: 52px;
  font-size: 1rem;
}
.tablet .gate-reader.tall {
  min-height: 320px;
}
</style>
