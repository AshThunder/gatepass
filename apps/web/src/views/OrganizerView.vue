<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import { connectNimiq, ensureConsensus, isDemoAllowed, payForHallRent, toErrorMessage } from '@/nimiq/wallet'
import { useWallet } from '@/nimiq/useWallet'
import { newId } from '@/lib/id'
import { copyToClipboard } from '@/lib/copy'
import { ensureInboxSession } from '@/lib/session'
import EventCard from '@/components/EventCard.vue'
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
import EventShareCard from '@/components/EventShareCard.vue'
import HallMapPreview from '@/components/HallMapPreview.vue'
import FlashBanner from '@/components/FlashBanner.vue'

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
const hostPanel = ref<'create' | 'manage'>('create')
const staffPasscode = ref('')
const staffQr = ref('')
const manageStaffPass = ref('')
const showLiveBanner = ref(false)

/** Nimiq Hall booking */
const hall = ref<import('@gatepass/shared').HallInfo | null>(null)
const hallSlotId = ref('')
const hallTitle = ref('')
const hallTicketPrice = ref(1)
const hallBooking = ref(false)
const showHallPreview = ref(false)
const hallOpen = ref(false)

const props = defineProps<{
  expandHall?: boolean
  active?: boolean
}>()

const emit = defineEmits<{
  checkIn: [payload: { eventId: string, token: string, secret: string }]
}>()

function eventUrl(id: string) {
  return `${window.location.origin}${window.location.pathname}${eventSharePath(id)}`
}

const shareUrl = computed(() => {
  const id = created.value?.event.id || manageEventId.value
  if (!id)
    return window.location.origin
  return eventUrl(id)
})

const gateUnlockUrl = computed(() => {
  const id = manageEventId.value
  if (!id)
    return ''
  const payload = localStorage.getItem(`gatepass:event:${id}:unlockPayload`) || unlockPayload.value
  return payload || `${window.location.origin}${window.location.pathname}?tab=gate&tablet=1`
})

const payDeeplink = computed(() =>
  `nimiqpay://miniapp?url=${encodeURIComponent(shareUrl.value)}`,
)

async function copyText(text: string, okMsg: string) {
  const ok = await copyToClipboard(text)
  status.value = ok ? okMsg : 'Could not copy — long-press the text instead'
}

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

const manageEvent = computed(() =>
  myEvents.value.find(e => e.id === manageEventId.value) || null,
)

const justCreatedId = computed(() =>
  showLiveBanner.value ? (created.value?.event.id || null) : null,
)

async function refreshDoorKit(id: string) {
  manageStaffPass.value = localStorage.getItem(`gatepass:event:${id}:staffPass`) || ''
  const unlock = localStorage.getItem(`gatepass:event:${id}:unlockPayload`)
    || (created.value?.event.id === id ? unlockPayload.value : '')
  if (unlock)
    unlockPayload.value = unlock
}

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

function masterFor(eventId: string): string {
  const raw = localStorage.getItem(`gatepass:event:${eventId}:master`)
  if (!raw)
    return ''
  try {
    return (JSON.parse(raw) as { eventMasterSecret: string }).eventMasterSecret || ''
  }
  catch {
    return ''
  }
}

function persistHostKeys(eventId: string, token: string, secret: string) {
  manageToken.value = token
  localStorage.setItem(`gatepass:event:${eventId}:master`, JSON.stringify({
    eventMasterSecret: secret,
    gateUnlockToken: token,
  }))
  const unlock = encodeGateUnlock(eventId, secret, token)
  unlockPayload.value = unlock
  localStorage.setItem(`gatepass:event:${eventId}:unlockPayload`, unlock)
}

const hostAccessInflight = new Map<string, Promise<boolean>>()

async function ensureHostAccess(eventId: string): Promise<boolean> {
  const pending = hostAccessInflight.get(eventId)
  if (pending)
    return pending

  const run = (async () => {
    const local = tokenFor(eventId)
    if (local) {
      manageToken.value = local
      return true
    }
    manageToken.value = ''
    const addr = organizerAddress.value.trim()
    if (!addr)
      return false
    try {
      const session = await ensureInboxSession(addr)
      const res = await api.hostUnlock(eventId, session.token)
      persistHostKeys(eventId, res.gateUnlockToken, res.eventMasterSecret)
      return true
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  })()

  hostAccessInflight.set(eventId, run)
  try {
    return await run
  }
  finally {
    hostAccessInflight.delete(eventId)
  }
}

async function refreshEvents() {
  const res = await api.listEvents()
  events.value = res.events
  const mine = events.value.filter(isMine)
  if (manageEventId.value && !mine.some(e => e.id === manageEventId.value))
    manageEventId.value = ''
  if (manageEventId.value)
    manageToken.value = tokenFor(manageEventId.value)
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
  if (!id) {
    guests.value = []
    waitlist.value = []
    return
  }
  manageStaffPass.value = ''
  guests.value = []
  waitlist.value = []
  void prepareManagedEvent(id)
})

async function prepareManagedEvent(id: string) {
  await ensureHostAccess(id)
  await refreshDoorKit(id)
  if (manageToken.value.trim() || tokenFor(id))
    void loadGuests(true)
}

async function checkInGuests() {
  const id = manageEventId.value
  if (!id)
    return
  error.value = ''
  loading.value = true
  try {
    const ok = await ensureHostAccess(id)
    if (!ok) {
      if (!error.value)
        error.value = 'Connect the host wallet to check in guests'
      return
    }
    const token = manageToken.value.trim() || tokenFor(id)
    const secret = masterFor(id)
    if (!token) {
      error.value = 'Could not unlock this event'
      return
    }
    emit('checkIn', { eventId: id, token, secret })
  }
  finally {
    loading.value = false
  }
}

function closeManagedEvent() {
  manageEventId.value = ''
}

function addressShort(addr: string) {
  const clean = addr.replace(/\s+/g, '')
  if (clean.length < 12)
    return `Connected ${addr}`
  return `Connected ${clean.slice(0, 6)}…${clean.slice(-4)}`
}

function shortAddr(addr: string) {
  const clean = addr.replace(/\s+/g, '')
  if (clean.length < 12)
    return addr
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`
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

    const res = await api.createEvent({
      ...body,
      staffPasscode: randomStaffPin(),
    })
    created.value = res
    manageEventId.value = res.event.id
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
    if (res.staffPasscode) {
      staffPasscode.value = res.staffPasscode
      localStorage.setItem(`gatepass:event:${res.event.id}:staffPass`, res.staffPasscode)
      staffQr.value = await renderStaffQr(res.event.id, res.staffPasscode)
    }
    await refreshEvents()
    showLiveBanner.value = true
    status.value = 'Event live — copy the link and share it'
    hostPanel.value = 'manage'
    manageToken.value = res.gateUnlockToken
    await refreshDoorKit(res.event.id)
    await loadGuests().catch(() => {})
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function loadHall() {
  try {
    hall.value = await api.getHall()
    const open = hall.value.slots.find(s => s.status === 'open')
    if (open && !hallSlotId.value)
      hallSlotId.value = open.id
  }
  catch { /* optional */ }
}

const nextHallSlotLabel = computed(() => {
  const s = (hall.value?.slots || []).find(x => x.status === 'open')
  if (!s)
    return 'No open slots'
  return new Date(s.startsAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
})

watch(() => props.expandHall, (on) => {
  if (on)
    hallOpen.value = true
})

watch(() => props.active, (on, was) => {
  if (on && was === false)
    hallOpen.value = !!props.expandHall
})

function onHallToggle(ev: Event) {
  hallOpen.value = (ev.currentTarget as HTMLDetailsElement).open
}

async function bookHall() {
  error.value = ''
  status.value = ''
  hallBooking.value = true
  loading.value = true
  try {
    if (!hall.value || !hallSlotId.value)
      throw new Error('Pick a hall slot')
    if (!organizerAddress.value.trim())
      throw new Error('Connect wallet / set payout address first')
    if (!hallTitle.value.trim())
      throw new Error('Event title required')
    const slot = hall.value.slots.find(s => s.id === hallSlotId.value)
    if (!slot || slot.status !== 'open')
      throw new Error('Pick an open hall slot')

    let txHash: string
    const demo = isDemoAllowed() && (!hall.value.platformAddress || !walletReady.value)
    if (demo) {
      txHash = `demo-hall-${newId()}`
    }
    else {
      if (!hall.value.platformAddress)
        throw new Error('Hall platform address not configured')
      status.value = 'Waiting for Nimiq Pay to sync…'
      const provider = await connectNimiq()
      await ensureConsensus(provider)
      status.value = 'Approve hall rent in Nimiq Pay…'
      txHash = await payForHallRent(provider, {
        recipient: hall.value.platformAddress,
        slotId: slot.id,
        rentLuna: slot.rentLuna,
      })
    }

    status.value = 'Booking Nimiq Hall…'
    const res = await api.rentHall(slot.id, {
      txHash,
      organizerAddress: organizerAddress.value.trim(),
      title: hallTitle.value.trim(),
      ticketPriceNim: Number(hallTicketPrice.value) || 1,
      demo: txHash.startsWith('demo-'),
      hideSoldCount: hideSoldCount.value,
      hideRedeemedCount: hideRedeemedCount.value,
    })
    created.value = {
      event: res.event,
      eventMasterSecret: res.eventMasterSecret,
      gateUnlockToken: res.gateUnlockToken,
      staffPasscode: res.staffPasscode,
    }
    manageEventId.value = res.event.id
    manageToken.value = res.gateUnlockToken
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
    if (res.staffPasscode) {
      staffPasscode.value = res.staffPasscode
      localStorage.setItem(`gatepass:event:${res.event.id}:staffPass`, res.staffPasscode)
      staffQr.value = await renderStaffQr(res.event.id, res.staffPasscode)
    }
    await refreshEvents()
    await loadHall()
    showLiveBanner.value = true
    status.value = 'Nimiq Hall booked — event is live'
    hostPanel.value = 'manage'
    await refreshDoorKit(res.event.id)
  }
  catch (err) {
    error.value = toErrorMessage(err)
    status.value = ''
  }
  finally {
    loading.value = false
    hallBooking.value = false
  }
}

async function copyUnlock() {
  if (!unlockPayload.value)
    return
  const ok = await copyToClipboard(unlockPayload.value)
  if (ok) {
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  }
  else {
    error.value = 'Could not copy — long-press the code instead'
  }
}

async function copyShare() {
  const ok = await copyToClipboard(shareUrl.value)
  status.value = ok ? 'Event link copied' : 'Could not copy — long-press the link instead'
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
  const ok = await copyToClipboard(pin)
  status.value = ok ? 'Staff passcode copied' : 'Could not copy — long-press the PIN instead'
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
    status.value = 'New door PIN ready — staff can use it at Gate'
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function saveStaffPass(passcode: string) {
  error.value = ''
  status.value = ''
  if (!manageEventId.value)
    return
  const pass = passcode.trim()
  if (!pass)
    return
  let token = manageToken.value.trim() || tokenFor(manageEventId.value)
  if (!token) {
    await ensureHostAccess(manageEventId.value)
    token = manageToken.value.trim() || tokenFor(manageEventId.value)
  }
  if (!token) {
    error.value = 'Connect the host wallet to change the door PIN'
    return
  }
  loading.value = true
  try {
    const res = await api.setStaffPasscode(manageEventId.value, token, pass)
    localStorage.setItem(`gatepass:event:${manageEventId.value}:staffPass`, pass)
    manageStaffPass.value = res.staffPasscode || pass
    status.value = 'Door PIN saved'
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
  const pin = randomStaffPin()
  manageStaffPass.value = pin
  await saveStaffPass(pin)
}

async function loadGuests(quiet = false) {
  error.value = ''
  if (!quiet)
    status.value = ''
  if (!manageEventId.value)
    return
  let token = manageToken.value.trim() || tokenFor(manageEventId.value)
  if (!token) {
    await ensureHostAccess(manageEventId.value)
    token = manageToken.value.trim() || tokenFor(manageEventId.value)
  }
  if (!token) {
    if (!quiet)
      error.value = 'Connect the host wallet to see guests'
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
    if (!quiet)
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
  let token = manageToken.value.trim() || tokenFor(manageEventId.value)
  if (!token) {
    await ensureHostAccess(manageEventId.value)
    token = manageToken.value.trim() || tokenFor(manageEventId.value)
  }
  if (!token) {
    error.value = 'Connect the host wallet to void a ticket'
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
  void loadHall()
  void api.seatTemplates().then((r) => {
    seatTemplates.value = r.templates
  }).catch(() => {})
})
</script>

<template>
  <section class="host">
    <h1 class="gp-page-title">
      Host
    </h1>
    <p class="gp-page-sub">
      Create an event or book Nimiq Hall, then share the link.
    </p>

    <div class="gp-segment host-tabs" role="tablist">
      <button type="button" :class="{ active: hostPanel === 'create' }" @click="hostPanel = 'create'">
        Create
      </button>
      <button type="button" :class="{ active: hostPanel === 'manage' }" @click="hostPanel = 'manage'">
        My events
      </button>
    </div>

    <template v-if="hostPanel === 'create'">

      <details
        v-if="hall"
        class="gp-details hall-book"
        :open="hallOpen"
        @toggle="onHallToggle"
      >
        <summary>
          <span class="hall-book__line">
            <span class="gp-pill gold">Nimiq Hall</span>
            <span class="hall-book__next">{{ nextHallSlotLabel }}</span>
          </span>
        </summary>
        <div class="hall-book__body">
          <h2 class="gp-h2">
            Book the hall
          </h2>
          <p class="gp-sub">
            {{ hall.description }} Cap {{ hall.capacity }} · rent {{ hall.rentNim }} NIM.
          </p>
          <button
            class="gp-btn ghost sm"
            type="button"
            style="width: auto; margin-bottom: 10px;"
            @click="showHallPreview = !showHallPreview"
          >
            {{ showHallPreview ? 'Hide hall preview' : 'Hall preview' }}
          </button>
          <HallMapPreview
            v-if="showHallPreview && hall.previewSeats?.length"
            :seats="hall.previewSeats"
          />
          <label class="gp-label">Open slot</label>
          <select v-model="hallSlotId" class="gp-input gp-select">
            <option
              v-for="s in hall.slots.filter(x => x.status === 'open')"
              :key="s.id"
              :value="s.id"
            >
              {{ new Date(s.startsAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }}
            </option>
          </select>
          <p v-if="!hall.slots.some(s => s.status === 'open')" class="gp-banner warn">
            No open slots right now.
          </p>
          <label class="gp-label">Event title</label>
          <input v-model="hallTitle" class="gp-input" placeholder="Hex Night at Nimiq Hall">
          <label class="gp-label">Seat ticket price (NIM)</label>
          <input v-model.number="hallTicketPrice" class="gp-input" type="number" min="0" step="0.01">
          <button
            class="gp-btn secondary"
            type="button"
            :disabled="loading || !hallSlotId || !hallTitle.trim()"
            @click="bookHall"
          >
            {{ hallBooking ? 'Booking…' : `Rent hall · ${hall.rentNim} NIM` }}
          </button>
        </div>
      </details>

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
          A door PIN is created automatically. You’ll see it under My events.
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
      </div>
      <div class="gp-sticky-cta gp-sticky-cta--compact">
        <button class="gp-btn" :disabled="loading || !title || !venueName" type="button" @click="onCreate">
          {{ loading ? 'Creating…' : 'Create event' }}
        </button>
      </div>



    </template>

    <template v-else-if="hostPanel === 'manage'">
      <div v-if="!myEvents.length" class="gp-card">
        <h2 class="gp-h2">
          Your events
        </h2>
        <p class="gp-sub">
          Connect the wallet you used when creating. Then pick an event to share it and run the door.
        </p>
        <button class="gp-btn secondary" type="button" @click="connect">
          {{ walletReady ? 'Refresh wallet' : 'Connect Nimiq Pay' }}
        </button>
        <button class="gp-btn ghost" style="margin-top: 8px;" type="button" @click="hostPanel = 'create'">
          Create an event
        </button>
      </div>

      <template v-else-if="!manageEvent">
        <h2 class="gp-h2">
          Your events
        </h2>
        <p class="gp-sub">
          Open an event to share it, check in guests, and see who bought tickets.
        </p>
        <div class="manage-ev-list">
          <EventCard
            v-for="ev in myEvents"
            :key="ev.id"
            :event="ev"
            @select="manageEventId = ev.id"
          />
        </div>
      </template>

      <div v-else class="gp-card">
          <div class="manage-back">
            <button class="gp-btn ghost sm" type="button" style="width: auto;" @click="closeManagedEvent">
              ← Events
            </button>
          </div>

          <div v-if="justCreatedId === manageEvent.id" class="gp-banner ok">
            Your event is live. Share the link with guests.
          </div>

          <EventShareCard :event="manageEvent" />

          <div class="manage-block">
            <h2 class="gp-h2">
              Check in
            </h2>
            <p class="gp-sub">
              Scan tickets at the door on this phone.
            </p>
            <button
              class="gp-btn"
              type="button"
              style="margin-top: 12px;"
              :disabled="loading"
              @click="checkInGuests"
            >
              Check in guests
            </button>
          </div>

          <div class="manage-block">
            <h2 class="gp-h2">
              Staff
            </h2>
            <p v-if="manageStaffPass" class="gp-sub">
              Give this to anyone working the door. They open Gate and type it.
            </p>
            <p v-else-if="manageEvent.hasStaffPasscode" class="gp-sub">
              Staff already have a PIN. Change it to make a new one on this phone.
            </p>
            <p v-else class="gp-sub">
              Create a PIN so door staff can unlock Gate.
            </p>
            <div v-if="manageStaffPass" class="staff-pin">
              {{ manageStaffPass }}
            </div>
            <div class="gp-row" style="margin-top: 12px;">
              <button
                v-if="manageStaffPass"
                class="gp-btn secondary"
                type="button"
                @click="copyText(manageStaffPass, 'Door PIN copied')"
              >
                Copy PIN
              </button>
              <button
                class="gp-btn"
                :class="manageStaffPass || manageEvent.hasStaffPasscode ? 'secondary' : ''"
                type="button"
                :disabled="loading"
                @click="generateManageStaffPin"
              >
                {{ manageStaffPass || manageEvent.hasStaffPasscode ? 'Change PIN' : 'Create PIN' }}
              </button>
            </div>
          </div>

          <div class="manage-block">
            <div class="guest-head">
              <h2 class="gp-h2">
                Guests
              </h2>
              <button
                v-if="guests.length"
                type="button"
                class="manage-link"
                @click="exportCsv"
              >
                Export
              </button>
            </div>
            <p v-if="!guests.length" class="gp-sub">
              No tickets yet.
            </p>
            <ul v-if="guests.length" class="gp-list" style="margin-top: 8px;">
              <li v-for="g in guests" :key="g.ticketId">
                <div class="guest-row">
                  <div>
                    <strong style="text-transform: capitalize;">{{ g.status }}</strong>
                    <div v-if="g.tierName || g.seatLabel" class="gp-mono">
                      {{ [g.tierName, g.seatLabel].filter(Boolean).join(' · ') }}
                    </div>
                    <div class="gp-mono">
                      {{ shortAddr(g.buyerAddress) }}
                    </div>
                  </div>
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
              </li>
            </ul>
            <p v-if="waitlist.length" class="gp-banner" style="margin-top: 10px;">
              Waitlist ({{ waitlist.length }})
            </p>
          </div>
        </div>

    </template>

    <FlashBanner
      v-if="status"
      kind="success"
      :message="status"
      @clear="status = ''"
    />
    <FlashBanner
      v-if="error"
      :message="error"
      @clear="error = ''"
    />
  </section>
</template>

<style scoped>
.host {
  padding-bottom: calc(var(--gp-tabbar-h) + env(safe-area-inset-bottom, 0px) + 88px);
}
.host-tabs {
  grid-template-columns: 1fr 1fr;
}
.manage-block {
  margin-top: 18px;
}
.manage-block .gp-h2 {
  margin-bottom: 4px;
}
.manage-back {
  margin: -4px 0 10px;
}
.guest-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.guest-head .gp-h2 {
  margin: 0;
}
.manage-links {
  display: flex;
  gap: 16px;
  margin-top: 8px;
}
.manage-link {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--gp-muted);
  font-size: 0.82rem;
  font-weight: 500;
}
.manage-link:disabled {
  opacity: 0.38;
}
.guest-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.hall-book {
  margin: 0 0 14px;
}
.hall-book__line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.hall-book__next {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--gp-muted);
}
.hall-book__body {
  padding: 0 2px 8px;
}
.hall-book[open] .hall-book__body {
  background: rgba(233, 178, 19, 0.16);
  border-radius: 16px;
  padding: 12px 14px 14px;
}
.hall-book__body .gp-h2 {
  margin: 0 0 6px;
}
.hall-book__body .gp-btn.secondary {
  margin-top: 4px;
}
.tier-draft {
  border: 0;
  border-radius: 16px;
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
  border: 0;
  background: var(--gp-surface-soft);
  border-radius: 12px;
  padding: 10px 6px;
  font-size: 0.72rem;
  font-weight: 500;
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
  font-weight: 500;
}
.share-pane p {
  margin: 0 0 12px;
  color: var(--gp-muted);
  font-size: 0.92rem;
  line-height: 1.4;
}
.manage-ev-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}
.staff-pin {
  font-family: var(--gp-mono);
  font-size: 1.6rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-align: center;
  padding: 16px;
  border-radius: 16px;
  background: rgba(233, 178, 19, 0.18);
  color: var(--gp-navy);
  margin-top: 12px;
  margin-bottom: 4px !important;
  user-select: all;
  -webkit-user-select: all;
}
</style>
