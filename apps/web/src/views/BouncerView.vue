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

const STORAGE_KEY = 'gatepass:gateBundle'
const QUEUE_KEY = 'gatepass:redeemQueue'
const AUTO_MS = 45_000

type Mode = 'unlock' | 'scan'
type UnlockTab = 'host' | 'staff'

const mode = ref<Mode>('unlock')
const unlockTab = ref<UnlockTab>('host')
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
let scanner: Html5Qrcode | null = null
let handling = false
let autoTimer: ReturnType<typeof setInterval> | null = null

const cachedCount = computed(() => bundle.value?.tickets.length || 0)
const validCached = computed(() =>
  bundle.value?.tickets.filter(t => t.status === 'valid').length || 0,
)
const staffEvents = computed(() =>
  events.value.filter(e => e.hasStaffPasscode && Date.now() <= new Date(e.endsAt).getTime() + 6 * 3600_000),
)

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
  if (!parsed)
    throw new Error('Need host GPGATE… or staff GPSTAFF… QR — not a ticket QR')
  const data = await api.gateBundle(parsed.eventId, parsed.unlockToken)
  await applyBundle(data, parsed.unlockToken, parsed.masterSecret)
}

async function unlockManual() {
  error.value = ''
  message.value = ''
  const raw = unlockInput.value.trim()
  if (!raw) {
    error.value = 'Paste GPGATE… or eventId|token'
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
      error.value = 'That’s a ticket. Stay in Unlock mode and use the host / staff QR first.'
      return
    }
    const [eventId, token] = raw.split('|').map(s => s.trim())
    if (eventId && token) {
      const data = await api.gateBundle(eventId, token)
      await applyBundle(data, token)
      return
    }
    error.value = 'Unrecognized unlock text'
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
    error.value = 'Enter staff passcode'
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
      if (mode.value === 'unlock')
        throw new Error('In Unlock mode — scan host GPGATE or staff GPSTAFF QR')
    }

    if (!bundle.value || !unlocked.value)
      throw new Error('Gate locked — unlock first')

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
  restoreBundle()
  refreshCameraCapability()
  if (unlocked.value && mode.value === 'scan')
    void startScan()
  pendingCount.value = loadQueue().length
  void syncQueue()
  autoTimer = setInterval(() => {
    if (!unlocked.value || !bundle.value)
      return
    void refreshBundle().catch(() => {})
    void syncQueue()
  }, AUTO_MS)
  try {
    const res = await api.listEvents()
    events.value = res.events
    const withPin = staffEvents.value[0]
    if (withPin)
      staffEventId.value = withPin.id
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
  <section>
    <h1 class="gp-page-title">
      Gate
    </h1>
    <p class="gp-page-sub">
      {{ unlocked ? 'Scanning tickets for this door.' : 'Unlock once, then keep scanning.' }}
    </p>

    <div class="gp-segment">
      <button type="button" :class="{ active: mode === 'unlock' }" @click="mode = 'unlock'">
        Unlock
      </button>
      <button
        type="button"
        :class="{ active: mode === 'scan' }"
        :disabled="!unlocked"
        @click="unlocked && (mode = 'scan')"
      >
        Scan
      </button>
    </div>

    <div v-if="mode === 'unlock'" class="gp-card">
      <div v-if="unlocked" class="gp-banner ok">
        Unlocked for <strong>{{ bundle?.eventTitle }}</strong>.
        <div class="gp-row" style="margin-top: 10px;">
          <button class="gp-btn secondary sm" type="button" @click="mode = 'scan'">
            Back to scan
          </button>
          <button class="gp-btn ghost sm" type="button" @click="lockGate">
            Lock
          </button>
        </div>
      </div>

      <template v-else>
        <div class="gp-segment" style="margin-bottom: 14px;">
          <button type="button" :class="{ active: unlockTab === 'host' }" @click="unlockTab = 'host'">
            Host QR
          </button>
          <button type="button" :class="{ active: unlockTab === 'staff' }" @click="unlockTab = 'staff'">
            Staff PIN
          </button>
        </div>

        <template v-if="unlockTab === 'host'">
          <p class="gp-sub">
            Scan host <strong>GPGATE</strong> or staff <strong>GPSTAFF</strong> QR from the organizer — never a guest ticket.
          </p>
          <label class="gp-label">Unlock payload</label>
          <textarea v-model="unlockInput" class="gp-textarea" placeholder="GPGATE:… or GPSTAFF:…" />
          <button class="gp-btn" type="button" @click="unlockManual">
            Unlock with pasted code
          </button>
        </template>

        <template v-else>
          <p class="gp-sub">
            Or type the staff PIN manually. Prefer scanning the staff QR from Host → Share night.
          </p>
          <label class="gp-label">Event</label>
          <select v-model="staffEventId" class="gp-input gp-select">
            <option disabled value="">
              Select event
            </option>
            <option v-for="ev in staffEvents" :key="ev.id" :value="ev.id">
              {{ ev.title }}
            </option>
          </select>
          <p v-if="!staffEvents.length" class="gp-banner warn">
            No events with a staff PIN. Ask the host to set one, or use Host QR.
          </p>
          <label class="gp-label">Staff passcode</label>
          <input
            v-model="staffPass"
            class="gp-input"
            type="password"
            inputmode="numeric"
            autocomplete="off"
            placeholder="PIN"
          >
          <button class="gp-btn" type="button" @click="unlockWithStaffPass">
            Unlock with staff PIN
          </button>
        </template>
      </template>
    </div>

    <div v-if="mode === 'scan'" class="gp-card">
      <div class="gp-chip-row">
        <span class="gp-pill ok">{{ scanning ? 'Live' : 'Ready' }}</span>
        <span v-if="lastSyncedLabel" class="gp-pill muted">{{ lastSyncedLabel }}</span>
      </div>
      <h2 class="gp-h2">
        {{ bundle?.eventTitle }}
      </h2>
      <div class="gp-stat-grid">
        <div class="gp-stat">
          <strong>{{ cachedCount }}</strong>
          <span>cached</span>
        </div>
        <div class="gp-stat">
          <strong>{{ validCached }}</strong>
          <span>valid</span>
        </div>
        <div class="gp-stat">
          <strong>{{ pendingCount }}</strong>
          <span>queued</span>
        </div>
      </div>
      <div class="gp-row">
        <button class="gp-btn secondary sm" type="button" @click="refreshBundle">
          Refresh list
        </button>
        <button class="gp-btn ghost sm" type="button" @click="syncQueue">
          Sync queue
        </button>
      </div>
    </div>

    <div class="gp-card">
      <h2 class="gp-h2">
        {{ mode === 'unlock' ? 'Point at unlock QR' : 'Point at ticket QR' }}
      </h2>
      <div id="gate-reader" class="gate-reader" />
      <p v-if="cameraHint" class="gp-banner" style="margin-top: 10px;">
        {{ cameraHint }}
      </p>
      <div class="gp-row" style="margin-top: 12px;">
        <button v-if="!scanning" class="gp-btn" type="button" @click="startScan">
          {{ mode === 'unlock' ? 'Start camera' : 'Resume camera' }}
        </button>
        <button v-else class="gp-btn danger" type="button" @click="stopScan">
          Pause camera
        </button>
      </div>

      <details v-if="mode === 'scan'" class="gp-details" style="margin-top: 12px;">
        <summary>Paste ticket instead</summary>
        <textarea v-model="ticketInput" class="gp-textarea" placeholder="GP1:…" />
        <button class="gp-btn secondary sm" type="button" @click="submitTicketPaste">
          Check in
        </button>
      </details>

      <div v-if="lastResult" class="gate-result" :class="lastResult">
        {{ lastResult === 'ok' ? 'ACCEPT' : 'DENY' }}
      </div>
      <p v-if="message" class="gp-success">
        {{ message }}
      </p>
      <p v-if="error" class="gp-error">
        {{ error }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.gate-reader {
  width: 100%;
  overflow: hidden;
  border-radius: 14px;
  min-height: 8px;
  background: rgba(31, 35, 72, 0.04);
}
.gate-result {
  margin-top: 14px;
  text-align: center;
  font-weight: 900;
  font-size: 1.4rem;
  letter-spacing: 0.08em;
  padding: 16px;
  border-radius: var(--gp-radius-sm);
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
</style>
