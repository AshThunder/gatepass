<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import { isDemoAllowed } from '@/nimiq/wallet'
import { useWallet } from '@/nimiq/useWallet'
import { encodeGateUnlock, encodeStaffUnlock } from '@/crypto/ticket'
import type {
  CreateEventResponse,
  CreateTierInput,
  EventRecord,
  GuestRow,
  SeatTemplateId,
  TierKind,
  WaitlistEntry,
} from '@gatepass/shared'
import { eventSharePath } from '@gatepass/shared'
import QRCode from 'qrcode'

interface TierDraft {
  name: string
  kind: TierKind
  priceNim: number
  capacity: number | null
  unlimited: boolean
  perOrderMin: number
  perOrderMax: number
  mapTemplate: SeatTemplateId | null
}

const title = ref('')
const description = ref('')
const coverUrl = ref('')
const venueName = ref('')
const venueLat = ref('')
const venueLng = ref('')
const priceNim = ref(1)
const capacity = ref<number | null>(100)
const capacityUnlimited = ref(false)
const useAdvancedTiers = ref(false)
const hideSoldCount = ref(false)
const hideRedeemedCount = ref(false)
const startsAt = ref('')
const endsAt = ref('')
const organizerAddress = ref('')
const loading = ref(false)
const error = ref('')
const status = ref('')
const created = ref<CreateEventResponse | null>(null)
const gateQr = ref('')
const unlockPayload = ref('')
const events = ref<EventRecord[]>([])
const copied = ref(false)
const seatTemplates = ref<Array<{ id: SeatTemplateId, label: string, description: string }>>([])

function blankTier(): TierDraft[] {
  return [{
    name: 'General Admission',
    kind: 'ga',
    priceNim: priceNim.value,
    capacity: capacityUnlimited.value ? null : (capacity.value || 100),
    unlimited: capacityUnlimited.value,
    perOrderMin: 1,
    perOrderMax: 10,
    mapTemplate: null,
  }]
}

const tierDrafts = ref<TierDraft[]>(blankTier())

function openAdvancedTiers() {
  if (!useAdvancedTiers.value) {
    // Seed first tier from simple price/capacity
    const first = tierDrafts.value[0]
    if (first) {
      first.priceNim = Number(priceNim.value) || 0
      first.unlimited = capacityUnlimited.value
      first.capacity = capacityUnlimited.value ? null : (capacity.value || 100)
    }
    else {
      tierDrafts.value = blankTier()
    }
  }
  useAdvancedTiers.value = true
}

function addTier() {
  openAdvancedTiers()
  tierDrafts.value.push({
    name: 'VIP',
    kind: 'vip',
    priceNim: 5,
    capacity: 20,
    unlimited: false,
    perOrderMin: 1,
    perOrderMax: 4,
    mapTemplate: null,
  })
}

function removeTier(i: number) {
  if (tierDrafts.value.length <= 1)
    return
  tierDrafts.value.splice(i, 1)
}

function onKindChange(t: TierDraft) {
  if (t.kind === 'reserved') {
    t.mapTemplate = t.mapTemplate || 'theater-200'
    t.unlimited = false
    t.capacity = null
  }
  else {
    t.mapTemplate = null
    if (t.capacity == null)
      t.capacity = 100
  }
}

function onAdvancedToggle(ev: Event) {
  const el = ev.target as HTMLDetailsElement
  if (el.open)
    openAdvancedTiers()
  else
    useAdvancedTiers.value = false
}

const {
  address: walletAddress,
  ready: walletReady,
  connect: connectShared,
  probe: probeShared,
} = useWallet()

const walletMessage = computed(() => {
  if (walletReady.value && organizerAddress.value)
    return addressShort(organizerAddress.value)
  if (isDemoAllowed())
    return 'Tap Connect, or edit address for demo'
  return 'Tap Connect for payout address'
})

const manageEventId = ref('')
const manageToken = ref('')
const guests = ref<GuestRow[]>([])
const waitlist = ref<WaitlistEntry[]>([])
const cancelTicketId = ref('')
const hostPanel = ref<'create' | 'manage' | 'share'>('create')
const staffPasscode = ref('')
const staffQr = ref('')
const manageStaffPass = ref('')
const manageStaffQr = ref('')
const shareStep = ref(0)

const shareUrl = computed(() => {
  const id = created.value?.event.id || manageEventId.value
  if (!id)
    return window.location.origin
  return `${window.location.origin}${window.location.pathname}${eventSharePath(id)}`
})

const payDeeplink = computed(() =>
  `nimiqpay://miniapp?url=${encodeURIComponent(shareUrl.value)}`,
)

function normAddr(addr: string) {
  return addr.replace(/\s+/g, '').toUpperCase()
}

function isMine(ev: EventRecord) {
  const me = normAddr(organizerAddress.value)
  if (me && normAddr(ev.organizerAddress) === me)
    return true
  // Events created on this device (unlock material in localStorage)
  return !!tokenFor(ev.id)
}

/** Only this organizer’s events — never the full public catalog */
const myEvents = computed(() => events.value.filter(isMine))

function defaultTimes() {
  const start = new Date(Date.now() + 3600_000)
  const end = new Date(Date.now() + 5 * 3600_000)
  const toLocal = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  startsAt.value = toLocal(start)
  endsAt.value = toLocal(end)
}

function tokenFor(eventId: string): string {
  const raw = localStorage.getItem(`gatepass:event:${eventId}:master`)
  if (!raw)
    return ''
  try {
    return (JSON.parse(raw) as { gateUnlockToken: string }).gateUnlockToken || ''
  }
  catch {
    return ''
  }
}

async function refreshEvents() {
  const res = await api.listEvents()
  events.value = res.events
  const mine = events.value.filter(isMine)
  if (!manageEventId.value || !mine.some(e => e.id === manageEventId.value))
    manageEventId.value = mine[0]?.id || ''
  if (manageEventId.value)
    manageToken.value = tokenFor(manageEventId.value) || manageToken.value
}

function syncOrganizerFromWallet() {
  if (walletAddress.value)
    organizerAddress.value = walletAddress.value
}

async function probeWallet() {
  await probeShared()
  syncOrganizerFromWallet()
  if (isDemoAllowed() && !organizerAddress.value)
    organizerAddress.value = 'NQ07 DEMO 0000 0000 0000 0000 0000 0000 0000'
  await refreshEvents()
}

async function connect() {
  error.value = ''
  const provider = await connectShared()
  syncOrganizerFromWallet()
  if (!provider && isDemoAllowed() && !organizerAddress.value)
    organizerAddress.value = 'NQ07 DEMO 0000 0000 0000 0000 0000 0000 0000'
  await refreshEvents()
}

watch(walletAddress, (addr) => {
  if (addr)
    organizerAddress.value = addr
})

watch(manageEventId, (id) => {
  if (!id)
    return
  manageToken.value = tokenFor(id) || manageToken.value
  manageStaffQr.value = ''
  guests.value = []
  waitlist.value = []
  if (tokenFor(id) || manageToken.value.trim())
    void loadGuests()
})

function addressShort(addr: string) {
  const clean = addr.replace(/\s+/g, '')
  if (clean.length < 12)
    return `Connected ${addr}`
  return `Connected ${clean.slice(0, 6)}…${clean.slice(-4)}`
}

function randomStaffPin() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

async function renderStaffQr(eventId: string, pin: string) {
  const payload = encodeStaffUnlock(eventId, pin)
  return QRCode.toDataURL(payload, {
    width: 240,
    margin: 1,
    color: { dark: '#1F2348', light: '#FFFFFF' },
  })
}

async function onCreate() {
  error.value = ''
  status.value = ''
  loading.value = true
  created.value = null
  gateQr.value = ''
  try {
    if (!organizerAddress.value.trim())
      throw new Error('Organizer address required')

    const privacy = {
      hideSoldCount: hideSoldCount.value,
      hideRedeemedCount: hideRedeemedCount.value,
    }

    let body: Parameters<typeof api.createEvent>[0]
    if (useAdvancedTiers.value) {
      if (!tierDrafts.value.length)
        throw new Error('Add at least one ticket tier')
      const tiers: CreateTierInput[] = tierDrafts.value.map((t) => {
        if (t.kind === 'reserved' && !t.mapTemplate)
          throw new Error(`${t.name}: pick a seat map template`)
        return {
          name: t.name.trim() || 'Ticket',
          kind: t.kind,
          priceNim: Number(t.priceNim) || 0,
          capacity: t.kind === 'reserved' ? null : (t.unlimited ? null : (t.capacity || null)),
          perOrderMin: t.kind === 'group' ? Math.max(2, t.perOrderMin) : t.perOrderMin,
          perOrderMax: t.perOrderMax,
          mapTemplate: t.kind === 'reserved' ? t.mapTemplate : null,
        }
      })
      body = {
        title: title.value,
        description: description.value.trim() || undefined,
        coverUrl: coverUrl.value.trim() || null,
        venueName: venueName.value,
        venueLat: venueLat.value ? Number(venueLat.value) : null,
        venueLng: venueLng.value ? Number(venueLng.value) : null,
        tiers,
        startsAt: new Date(startsAt.value).toISOString(),
        endsAt: new Date(endsAt.value).toISOString(),
        organizerAddress: organizerAddress.value.trim(),
        ...privacy,
      }
    }
    else {
      body = {
        title: title.value,
        description: description.value.trim() || undefined,
        coverUrl: coverUrl.value.trim() || null,
        venueName: venueName.value,
        venueLat: venueLat.value ? Number(venueLat.value) : null,
        venueLng: venueLng.value ? Number(venueLng.value) : null,
        priceNim: Number(priceNim.value) || 0,
        capacity: capacityUnlimited.value ? null : (capacity.value || null),
        startsAt: new Date(startsAt.value).toISOString(),
        endsAt: new Date(endsAt.value).toISOString(),
        organizerAddress: organizerAddress.value.trim(),
        ...privacy,
      }
    }

    const res = await api.createEvent(body)
    created.value = res
    manageEventId.value = res.event.id
    staffPasscode.value = ''
    staffQr.value = ''
    const unlock = encodeGateUnlock(res.event.id, res.eventMasterSecret, res.gateUnlockToken)
    unlockPayload.value = unlock
    gateQr.value = await QRCode.toDataURL(unlock, {
      width: 240,
      margin: 1,
      color: { dark: '#1F2348', light: '#FFFFFF' },
    })
    localStorage.setItem(`gatepass:event:${res.event.id}:master`, JSON.stringify({
      eventMasterSecret: res.eventMasterSecret,
      gateUnlockToken: res.gateUnlockToken,
    }))
    localStorage.setItem(`gatepass:event:${res.event.id}:unlockPayload`, unlock)
    await refreshEvents()
    status.value = 'Event live — set up guests, door lead, then staff'
    shareStep.value = 0
    hostPanel.value = 'share'
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function copyUnlock() {
  if (!unlockPayload.value)
    return
  try {
    await navigator.clipboard.writeText(unlockPayload.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  }
  catch {
    error.value = 'Could not copy — select the GPGATE text manually'
  }
}

async function copyShare() {
  try {
    await navigator.clipboard.writeText(shareUrl.value)
    status.value = 'Event link copied'
  }
  catch {
    status.value = shareUrl.value
  }
}

async function copyStaffPass() {
  const pin = staffPasscode.value
    || created.value?.staffPasscode
    || localStorage.getItem(`gatepass:event:${manageEventId.value}:staffPass`)
    || manageStaffPass.value
  if (!pin) {
    error.value = 'No staff passcode yet — generate one first'
    return
  }
  try {
    await navigator.clipboard.writeText(pin)
    status.value = 'Staff passcode copied'
  }
  catch {
    status.value = pin
  }
}

async function generateStaffAccess() {
  error.value = ''
  status.value = ''
  if (!created.value)
    return
  const token = created.value.gateUnlockToken || tokenFor(created.value.event.id)
  if (!token) {
    error.value = 'Missing gate unlock token'
    return
  }
  loading.value = true
  try {
    const pin = randomStaffPin()
    const res = await api.setStaffPasscode(created.value.event.id, token, pin)
    const saved = res.staffPasscode || pin
    staffPasscode.value = saved
    created.value = { ...created.value, staffPasscode: saved }
    localStorage.setItem(`gatepass:event:${created.value.event.id}:staffPass`, saved)
    staffQr.value = await renderStaffQr(created.value.event.id, saved)
    status.value = 'Staff PIN + QR ready — staff can scan this in Gate'
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function saveStaffPass() {
  error.value = ''
  status.value = ''
  if (!manageEventId.value)
    return
  const token = manageToken.value.trim() || tokenFor(manageEventId.value)
  if (!token) {
    error.value = 'Unlock token required to set staff passcode'
    return
  }
  loading.value = true
  try {
    const pass = manageStaffPass.value.trim() || null
    const res = await api.setStaffPasscode(manageEventId.value, token, pass)
    if (res.staffPasscode) {
      localStorage.setItem(`gatepass:event:${manageEventId.value}:staffPass`, res.staffPasscode)
      manageStaffQr.value = await renderStaffQr(manageEventId.value, res.staffPasscode)
    }
    else {
      localStorage.removeItem(`gatepass:event:${manageEventId.value}:staffPass`)
      manageStaffQr.value = ''
    }
    status.value = res.hasStaffPasscode ? 'Staff passcode saved' : 'Staff passcode cleared'
    await refreshEvents()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function generateManageStaffPin() {
  manageStaffPass.value = randomStaffPin()
  await saveStaffPass()
}

async function loadGuests() {
  error.value = ''
  status.value = ''
  if (!manageEventId.value)
    return
  const token = manageToken.value.trim() || tokenFor(manageEventId.value)
  if (!token) {
    error.value = 'Paste gate unlock token (from create) to load guests'
    return
  }
  manageToken.value = token
  loading.value = true
  try {
    const [g, w] = await Promise.all([
      api.guests(manageEventId.value, token),
      api.waitlist(manageEventId.value, token),
    ])
    guests.value = g.guests
    waitlist.value = w.waitlist
    status.value = `${guests.value.length} guest(s), ${waitlist.value.length} waitlisted`
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

function exportCsv() {
  if (!guests.value.length) {
    error.value = 'Load guests first'
    return
  }
  const header = 'ticketId,buyerAddress,status,tier,seat,txHash,createdAt,redeemedAt,cancelledAt'
  const rows = guests.value.map(g =>
    [
      g.ticketId,
      g.buyerAddress,
      g.status,
      g.tierName || '',
      g.seatLabel || '',
      g.txHash,
      g.createdAt,
      g.redeemedAt || '',
      g.cancelledAt || '',
    ]
      .map(c => `"${String(c).replace(/"/g, '""')}"`)
      .join(','),
  )
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `gatepass-guests-${manageEventId.value}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

async function voidTicket() {
  error.value = ''
  status.value = ''
  const id = cancelTicketId.value.trim()
  if (!id) {
    error.value = 'Enter ticket id to cancel'
    return
  }
  const token = manageToken.value.trim() || tokenFor(manageEventId.value)
  if (!token) {
    error.value = 'Unlock token required to cancel'
    return
  }
  loading.value = true
  try {
    await api.cancelTicket(id, token)
    status.value = `Cancelled ticket ${id}`
    cancelTicketId.value = ''
    await loadGuests()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

onMounted(() => {
  defaultTimes()
  void probeWallet()
  void refreshEvents().catch(() => {})
  void api.seatTemplates().then((r) => {
    seatTemplates.value = r.templates
  }).catch(() => {})
})
</script>

<template>
  <section>
    <h1 class="gp-page-title">
      Host
    </h1>
    <p class="gp-page-sub">
      Create events, share links, and manage the door.
    </p>

    <div class="gp-segment host-tabs" role="tablist">
      <button type="button" :class="{ active: hostPanel === 'create' }" @click="hostPanel = 'create'">
        Create
      </button>
      <button
        type="button"
        :class="{ active: hostPanel === 'share' }"
        :disabled="!created"
        @click="created && (hostPanel = 'share')"
      >
        Share night
      </button>
      <button type="button" :class="{ active: hostPanel === 'manage' }" @click="hostPanel = 'manage'">
        Manage
      </button>
    </div>

    <template v-if="hostPanel === 'create'">
      <div class="gp-card">
        <div class="gp-banner" :class="walletReady ? 'ok' : ''">
          {{ walletMessage }}
        </div>
        <button
          v-if="!walletReady"
          class="gp-btn secondary"
          style="margin-bottom: 14px;"
          type="button"
          @click="connect"
        >
          Connect Nimiq Pay
        </button>
        <button
          v-else
          class="gp-btn ghost sm"
          style="margin-bottom: 14px;"
          type="button"
          @click="connect"
        >
          Reconnect wallet
        </button>

        <label class="gp-label">Title</label>
        <input v-model="title" class="gp-input" placeholder="Hex Night Live">

        <label class="gp-label">Description</label>
        <textarea v-model="description" class="gp-textarea" placeholder="What should guests know?" rows="3" />

        <label class="gp-label">Venue</label>
        <input v-model="venueName" class="gp-input" placeholder="Nimiq Hub">

        <div class="gp-row">
          <div>
            <label class="gp-label">Price (NIM)</label>
            <input
              v-model.number="priceNim"
              class="gp-input"
              type="number"
              min="0"
              step="0.01"
              :disabled="useAdvancedTiers"
            >
          </div>
          <div>
            <label class="gp-label">Capacity</label>
            <input
              v-if="!capacityUnlimited"
              v-model.number="capacity"
              class="gp-input"
              type="number"
              min="1"
              step="1"
              placeholder="100"
              :disabled="useAdvancedTiers"
            >
            <button
              v-else
              class="gp-btn ghost sm"
              type="button"
              style="margin-bottom: 12px;"
              :disabled="useAdvancedTiers"
              @click="capacityUnlimited = false"
            >
              Set limit
            </button>
          </div>
        </div>
        <label v-if="!capacityUnlimited" class="gp-check">
          <input v-model="capacityUnlimited" type="checkbox" :disabled="useAdvancedTiers">
          Unlimited capacity
        </label>
        <p v-if="useAdvancedTiers" class="gp-sub" style="margin-top: -6px;">
          Price & capacity are set per tier below.
        </p>

        <label class="gp-check">
          <input v-model="hideSoldCount" type="checkbox">
          Hide tickets sold from public
        </label>
        <label class="gp-check">
          <input v-model="hideRedeemedCount" type="checkbox">
          Hide check-ins from public
        </label>

        <details class="gp-details" :open="useAdvancedTiers" @toggle="onAdvancedToggle">
          <summary>Advanced: ticket tiers & seat maps</summary>
          <p class="gp-sub">
            Optional. Add VIP, early bird, student, group, or reserved seats with a map.
          </p>
          <div v-for="(t, i) in tierDrafts" :key="i" class="tier-draft">
            <div class="gp-row">
              <div>
                <label class="gp-label">Name</label>
                <input v-model="t.name" class="gp-input" placeholder="General Admission">
              </div>
              <div>
                <label class="gp-label">Kind</label>
                <select v-model="t.kind" class="gp-input gp-select" @change="onKindChange(t)">
                  <option value="ga">
                    General
                  </option>
                  <option value="vip">
                    VIP
                  </option>
                  <option value="early_bird">
                    Early bird
                  </option>
                  <option value="student">
                    Student
                  </option>
                  <option value="group">
                    Group
                  </option>
                  <option value="reserved">
                    Reserved seats
                  </option>
                </select>
              </div>
            </div>
            <div class="gp-row">
              <div>
                <label class="gp-label">Price (NIM)</label>
                <input v-model.number="t.priceNim" class="gp-input" type="number" min="0" step="0.01">
              </div>
              <div v-if="t.kind !== 'reserved'">
                <label class="gp-label">Capacity</label>
                <input
                  v-if="!t.unlimited"
                  v-model.number="t.capacity"
                  class="gp-input"
                  type="number"
                  min="1"
                  step="1"
                >
                <button
                  v-else
                  class="gp-btn ghost sm"
                  type="button"
                  style="margin-bottom: 12px;"
                  @click="t.unlimited = false"
                >
                  Set limit
                </button>
              </div>
              <div v-else>
                <label class="gp-label">Seat map</label>
                <select v-model="t.mapTemplate" class="gp-input gp-select">
                  <option v-for="tpl in seatTemplates" :key="tpl.id" :value="tpl.id">
                    {{ tpl.label }}
                  </option>
                </select>
              </div>
            </div>
            <label v-if="t.kind !== 'reserved' && !t.unlimited" class="gp-check">
              <input v-model="t.unlimited" type="checkbox">
              Unlimited
            </label>
            <div v-if="t.kind === 'group'" class="gp-row">
              <div>
                <label class="gp-label">Min / order</label>
                <input v-model.number="t.perOrderMin" class="gp-input" type="number" min="2">
              </div>
              <div>
                <label class="gp-label">Max / order</label>
                <input v-model.number="t.perOrderMax" class="gp-input" type="number" min="2">
              </div>
            </div>
            <button
              v-if="tierDrafts.length > 1"
              class="gp-btn ghost sm"
              type="button"
              @click="removeTier(i)"
            >
              Remove tier
            </button>
          </div>
          <button class="gp-btn secondary sm" type="button" style="margin-bottom: 8px;" @click="addTier">
            Add tier
          </button>
        </details>

        <label class="gp-label">Starts</label>
        <input v-model="startsAt" class="gp-input" type="datetime-local">
        <label class="gp-label">Ends</label>
        <input v-model="endsAt" class="gp-input" type="datetime-local">

        <label class="gp-label">Payout address</label>
        <input v-model="organizerAddress" class="gp-input" placeholder="NQ…">
        <p class="gp-sub" style="margin-top: -6px;">
          Staff PIN / QR is generated after create in Share night.
        </p>

        <details class="gp-details">
          <summary>Optional: cover & map pin</summary>
          <label class="gp-label">Cover image URL</label>
          <input v-model="coverUrl" class="gp-input" placeholder="https://…">
          <div class="gp-row">
            <div>
              <label class="gp-label">Lat</label>
              <input v-model="venueLat" class="gp-input" placeholder="47.37">
            </div>
            <div>
              <label class="gp-label">Lng</label>
              <input v-model="venueLng" class="gp-input" placeholder="8.54">
            </div>
          </div>
        </details>

        <button class="gp-btn" :disabled="loading || !title || !venueName" type="button" @click="onCreate">
          {{ loading ? 'Creating…' : 'Create event' }}
        </button>
      </div>

    </template>

    <template v-else-if="hostPanel === 'share' && created">
      <div class="gp-card share-pack">
        <span class="gp-pill ok">Share night pack</span>
        <h2 class="gp-h2" style="margin-top: 10px;">
          {{ created.event.title }}
        </h2>
        <p class="gp-sub">
          Three things to hand out tonight — guests, door lead, and staff.
        </p>

        <div class="share-steps">
          <button type="button" class="share-step" :class="{ on: shareStep === 0 }" @click="shareStep = 0">
            1 · Guests
          </button>
          <button type="button" class="share-step" :class="{ on: shareStep === 1 }" @click="shareStep = 1">
            2 · Door lead
          </button>
          <button type="button" class="share-step" :class="{ on: shareStep === 2 }" @click="shareStep = 2">
            3 · Staff
          </button>
        </div>

        <div v-if="shareStep === 0" class="share-pane">
          <h3>Invite guests</h3>
          <p>Send the event link. They pay with NIM in Discover.</p>
          <p class="gp-mono">
            {{ shareUrl }}
          </p>
          <button class="gp-btn secondary" type="button" @click="copyShare">
            Copy event link
          </button>
          <p class="gp-label" style="margin-top: 12px;">
            Nimiq Pay deeplink
          </p>
          <p class="gp-mono">
            {{ payDeeplink }}
          </p>
        </div>

        <div v-else-if="shareStep === 1" class="share-pane">
          <h3>Door lead unlock</h3>
          <p>Scan this QR in the <strong>Gate</strong> tab first — never a ticket QR.</p>
          <div class="gp-qr">
            <img v-if="gateQr" :src="gateQr" alt="Gate unlock QR" width="220" height="220">
          </div>
          <button class="gp-btn secondary" type="button" @click="copyUnlock">
            {{ copied ? 'Copied' : 'Copy GPGATE unlock' }}
          </button>
        </div>

        <div v-else class="share-pane">
          <h3>Staff access</h3>
          <template v-if="staffPasscode && staffQr">
            <p>Staff open <strong>Gate → Unlock</strong> and scan this QR (or enter the PIN).</p>
            <div class="gp-qr">
              <img :src="staffQr" alt="Staff unlock QR" width="220" height="220">
            </div>
            <p class="staff-pin">
              {{ staffPasscode }}
            </p>
            <div class="gp-row">
              <button class="gp-btn secondary sm" type="button" @click="copyStaffPass">
                Copy PIN
              </button>
              <button class="gp-btn ghost sm" type="button" :disabled="loading" @click="generateStaffAccess">
                Regenerate
              </button>
            </div>
          </template>
          <template v-else>
            <p>Generate a staff PIN + QR after the event is created. Staff scan it at the gate — no host GPGATE needed.</p>
            <button class="gp-btn" type="button" :disabled="loading" @click="generateStaffAccess">
              {{ loading ? 'Generating…' : 'Generate staff PIN + QR' }}
            </button>
          </template>
        </div>

        <details class="gp-details">
          <summary>Advanced secrets</summary>
          <p class="gp-mono">
            {{ unlockPayload }}
          </p>
          <p class="gp-mono" style="margin-top: 8px;">
            {{ created.event.id }}|{{ created.gateUnlockToken }}
          </p>
          <p class="gp-mono" style="margin-top: 8px;">
            Master {{ created.eventMasterSecret }}
          </p>
        </details>
      </div>
    </template>

    <template v-else-if="hostPanel === 'manage'">
      <div v-if="!myEvents.length" class="gp-card">
        <h2 class="gp-h2">
          Your events
        </h2>
        <p class="gp-sub">
          Connect the wallet you used as payout address to manage guests and staff. Other people’s events stay private.
        </p>
        <button class="gp-btn secondary" type="button" @click="connect">
          {{ walletReady ? 'Refresh wallet' : 'Connect Nimiq Pay' }}
        </button>
        <button class="gp-btn ghost" style="margin-top: 8px;" type="button" @click="hostPanel = 'create'">
          Create an event
        </button>
      </div>

      <div v-else class="gp-card">
        <h2 class="gp-h2">
          Your events
        </h2>
        <ul class="gp-list" style="margin-bottom: 14px;">
          <li
            v-for="ev in myEvents"
            :key="ev.id"
            class="manage-ev"
            :class="{ on: manageEventId === ev.id }"
            @click="manageEventId = ev.id"
          >
            <strong>{{ ev.title }}</strong>
            <div class="gp-chip-row" style="margin-top: 8px; margin-bottom: 0;">
              <span class="gp-pill">{{ ev.soldCount }}{{ ev.capacity != null ? ` / ${ev.capacity}` : '' }} sold</span>
              <span class="gp-pill ok">{{ ev.redeemedCount }} in</span>
              <span v-if="ev.soldOut" class="gp-pill warn">Sold out</span>
            </div>
          </li>
        </ul>

        <h2 class="gp-h2">
          Guest list
        </h2>
        <p class="gp-sub">
          Loads when you pick an event. Void a ticket to deny at the gate.
        </p>
        <label class="gp-label">Selected event</label>
        <select v-model="manageEventId" class="gp-input gp-select">
          <option disabled value="">
            Select event
          </option>
          <option v-for="ev in myEvents" :key="ev.id" :value="ev.id">
            {{ ev.title }} · {{ ev.soldCount }} sold
          </option>
        </select>
        <details class="gp-details">
          <summary>Unlock token</summary>
          <input
            v-model="manageToken"
            class="gp-input"
            placeholder="Auto-filled if you created it here"
          >
        </details>
        <div class="gp-row">
          <button class="gp-btn secondary sm" type="button" :disabled="loading" @click="loadGuests">
            {{ guests.length ? 'Refresh' : 'Load guests' }}
          </button>
          <button class="gp-btn ghost sm" type="button" @click="exportCsv">
            CSV
          </button>
        </div>
        <ul v-if="guests.length" class="gp-list" style="margin-top: 12px;">
          <li v-for="g in guests" :key="g.ticketId">
            <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center;">
              <strong style="text-transform: capitalize;">{{ g.status }}</strong>
              <button
                v-if="g.status === 'valid'"
                class="gp-btn danger sm"
                type="button"
                style="width: auto; padding: 6px 12px;"
                @click="cancelTicketId = g.ticketId; voidTicket()"
              >
                Void
              </button>
            </div>
            <div class="gp-mono">
              {{ g.ticketId }}
            </div>
            <div v-if="g.tierName || g.seatLabel" class="gp-mono">
              {{ [g.tierName, g.seatLabel].filter(Boolean).join(' · ') }}
            </div>
            <div class="gp-mono">
              {{ g.buyerAddress }}
            </div>
          </li>
        </ul>
        <p v-if="waitlist.length" class="gp-banner" style="margin-top: 10px;">
          Waitlist ({{ waitlist.length }}): {{ waitlist.map(w => w.address).join(', ') }}
        </p>
        <details class="gp-details">
          <summary>Void by ticket id</summary>
          <input v-model="cancelTicketId" class="gp-input" placeholder="ticket id">
          <button class="gp-btn danger sm" type="button" :disabled="loading" @click="voidTicket">
            Void ticket
          </button>
        </details>

        <details class="gp-details">
          <summary>Staff PIN + QR</summary>
          <p class="gp-sub">
            Generate a scannable staff QR, or set a custom PIN. Staff scan it in Gate → Unlock.
          </p>
          <button class="gp-btn secondary sm" type="button" :disabled="loading" @click="generateManageStaffPin">
            Generate new PIN + QR
          </button>
          <label class="gp-label" style="margin-top: 12px;">Custom PIN</label>
          <input
            v-model="manageStaffPass"
            class="gp-input"
            placeholder="Or type a PIN, then save"
            autocomplete="off"
          >
          <button class="gp-btn ghost sm" type="button" :disabled="loading" @click="saveStaffPass">
            Save / clear (blank clears)
          </button>
          <div v-if="manageStaffQr" class="gp-qr" style="margin-top: 12px;">
            <img :src="manageStaffQr" alt="Staff unlock QR" width="200" height="200">
          </div>
        </details>
      </div>

    </template>

    <p v-if="status" class="gp-success">
      {{ status }}
    </p>
    <p v-if="error" class="gp-error">
      {{ error }}
    </p>
  </section>
</template>

<style scoped>
.host-tabs {
  grid-template-columns: 1fr 1fr 1fr;
}
.tier-draft {
  border: 1px solid var(--gp-border);
  border-radius: 14px;
  padding: 12px;
  margin-bottom: 10px;
  background: var(--gp-surface-soft);
}
.share-steps {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 6px;
  margin: 14px 0;
}
.share-step {
  border: 1px solid var(--gp-border);
  background: #fff;
  border-radius: 12px;
  padding: 10px 6px;
  font-size: 0.72rem;
  font-weight: 800;
  color: var(--gp-muted);
}
.share-step.on {
  background: var(--gp-navy);
  border-color: var(--gp-navy);
  color: #fff;
}
.share-pane h3 {
  margin: 0 0 6px;
  font-size: 1.05rem;
}
.share-pane p {
  margin: 0 0 12px;
  color: var(--gp-muted);
  font-size: 0.92rem;
  line-height: 1.4;
}
.manage-ev {
  cursor: pointer;
  border-radius: 12px;
  margin: 0 -6px;
  padding: 10px 6px !important;
  transition: background 140ms var(--gp-ease);
}
.manage-ev.on {
  background: rgba(233, 178, 19, 0.14);
}
.staff-pin {
  font-family: var(--gp-mono);
  font-size: 1.6rem;
  font-weight: 800;
  letter-spacing: 0.2em;
  text-align: center;
  padding: 16px;
  border-radius: 14px;
  background: rgba(233, 178, 19, 0.18);
  color: var(--gp-navy);
  margin-bottom: 12px !important;
}
</style>
