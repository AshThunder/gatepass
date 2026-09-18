<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import TierPicker from '@/components/TierPicker.vue'
import SeatMap from '@/components/SeatMap.vue'
import FlashBanner from '@/components/FlashBanner.vue'
import { connectNimiq, ensureConsensus, payForTicket, toErrorMessage } from '@/nimiq/wallet'
import { useWallet } from '@/nimiq/useWallet'
import { copyToClipboard } from '@/lib/copy'
import ResultDialog from '@/components/ResultDialog.vue'
import {
  clearReminder,
  hasReminder,
  requestNotifyPermission,
  setReminder,
} from '@/lib/reminders'
import {
  type EventRecord,
  type PurchaseItem,
  type TicketRecord,
  type TicketTier,
  eventSharePath,
  lunaToNim,
  mapsUrl,
  paymentMemo,
} from '@gatepass/shared'

const props = defineProps<{ eventId: string }>()
const emit = defineEmits<{
  back: []
  purchased: [tickets: TicketRecord[], event: EventRecord]
}>()

const event = ref<EventRecord | null>(null)
const loading = ref(false)
const error = ref('')
const status = ref('')
const lastTxHash = ref('')
const quantity = ref(1)
const selectedTierId = ref<string | null>(null)
const selectedSeatIds = ref<string[]>([])
const holdId = ref<string | null>(null)
const holdExpiresAt = ref<string | null>(null)
const holdSecondsLeft = ref(0)
const reminded = ref(false)
const successFlash = ref(false)
const resultOpen = ref(false)
const resultKind = ref<'success' | 'fail'>('success')
const resultTitle = ref('')
const resultMessage = ref('')
let invPoll: ReturnType<typeof setInterval> | null = null
let holdTimer: ReturnType<typeof setInterval> | null = null
let holdDebounce: ReturnType<typeof setTimeout> | null = null

const holdLabel = computed(() => {
  if (!holdExpiresAt.value || holdSecondsLeft.value <= 0)
    return ''
  const m = Math.floor(holdSecondsLeft.value / 60)
  const s = holdSecondsLeft.value % 60
  return `Seats held · ${m}:${String(s).padStart(2, '0')}`
})

function clearHoldLocal() {
  holdId.value = null
  holdExpiresAt.value = null
  holdSecondsLeft.value = 0
  if (holdTimer) {
    clearInterval(holdTimer)
    holdTimer = null
  }
}

function startHoldCountdown(expiresAt: string) {
  holdExpiresAt.value = expiresAt
  if (holdTimer)
    clearInterval(holdTimer)
  const tick = () => {
    const left = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
    holdSecondsLeft.value = left
    if (left <= 0) {
      clearHoldLocal()
      selectedSeatIds.value = []
      status.value = 'Hold expired — pick seats again'
    }
  }
  tick()
  holdTimer = setInterval(tick, 1000)
}

const { address, ready: providerReady, connect: connectShared, probe: probeWallet } = useWallet()

const selectedTier = computed((): TicketTier | null =>
  event.value?.tiers.find(t => t.id === selectedTierId.value) || null,
)

const isReserved = computed(() => selectedTier.value?.kind === 'reserved')

const cartItems = computed((): PurchaseItem[] => {
  if (!selectedTier.value)
    return []
  if (isReserved.value)
    return [{ tierId: selectedTier.value.id, seatIds: [...selectedSeatIds.value] }]
  return [{ tierId: selectedTier.value.id, quantity: quantity.value }]
})

const ticketCount = computed(() => {
  if (isReserved.value)
    return selectedSeatIds.value.length
  return quantity.value
})

const totalLuna = computed(() => {
  if (!selectedTier.value)
    return 0
  return selectedTier.value.priceLuna * ticketCount.value
})

const payLabel = computed(() => {
  if (!event.value || !selectedTier.value)
    return 'Select a ticket type'
  if (isReserved.value && !selectedSeatIds.value.length)
    return 'Select seats'
  const nim = lunaToNim(totalLuna.value)
  const base = nim === 0
    ? `Get ${ticketCount.value} free ticket(s)`
    : `Pay ${nim} NIM`
  if (!providerReady.value)
    return `Connect & ${nim === 0 ? 'get ticket' : 'pay'}`
  return base
})

const canBuy = computed(() => {
  if (!event.value || isPast.value || !selectedTier.value || !selectedTier.value.onSale)
    return false
  if (isReserved.value)
    return selectedSeatIds.value.length > 0
  return quantity.value >= selectedTier.value.perOrderMin
})

const isPast = computed(() =>
  event.value ? Date.now() > new Date(event.value.endsAt).getTime() : false,
)

const tierRemaining = computed(() => selectedTier.value?.remaining ?? null)

const shareUrl = computed(() =>
  `${window.location.origin}${window.location.pathname}${eventSharePath(props.eventId)}`,
)

function pickDefaultTier(ev: EventRecord) {
  const on = ev.tiers.find(t => t.onSale) || ev.tiers[0]
  selectedTierId.value = on?.id || null
  selectedSeatIds.value = []
  quantity.value = Math.max(1, on?.perOrderMin || 1)
}

async function load() {
  error.value = ''
  const res = await api.getEvent(props.eventId)
  event.value = res.event
  reminded.value = hasReminder(props.eventId)
  if (!selectedTierId.value || !res.event.tiers.some(t => t.id === selectedTierId.value))
    pickDefaultTier(res.event)
  else if (tierRemaining.value != null && quantity.value > tierRemaining.value)
    quantity.value = Math.max(1, tierRemaining.value)
}

async function refreshInventory() {
  if (!event.value)
    return
  try {
    const snap = await api.inventory(event.value.id, selectedTierId.value || undefined)
    for (const t of event.value.tiers) {
      const s = snap.tiers.find(x => x.id === t.id)
      if (!s)
        continue
      t.soldCount = s.soldCount
      t.remaining = s.remaining
      t.soldOut = s.soldOut
      t.onSale = s.onSale
    }
  }
  catch { /* ignore poll errors */ }
}

async function ensureWallet() {
  if (providerReady.value && address.value)
    return true
  const provider = await connectShared()
  return !!provider && !!address.value
}

function persistTickets(tickets: TicketRecord[], ev: EventRecord) {
  const raw = localStorage.getItem('gatepass:myTickets')
  let list: Array<{ ticket: TicketRecord, event: EventRecord, origin?: string }> = []
  try {
    list = raw ? JSON.parse(raw) as typeof list : []
  }
  catch { list = [] }
  for (const t of tickets) {
    list = list.filter(x => x.ticket.id !== t.id)
    list.unshift({ ticket: t, event: ev, origin: 'purchased' })
  }
  localStorage.setItem('gatepass:myTickets', JSON.stringify(list.slice(0, 40)))
  if (tickets[0]) {
    localStorage.setItem(
      'gatepass:myTicket',
      JSON.stringify({ ticket: tickets[0], event: ev, origin: 'purchased' }),
    )
  }
}

function purchaseTierLabel() {
  return selectedTier.value?.name || 'Ticket'
}

function purchaseAmountLabel() {
  const nim = lunaToNim(totalLuna.value)
  return nim === 0 ? 'Free' : `${nim} NIM`
}

function showResult(kind: 'success' | 'fail', title: string, message: string) {
  resultKind.value = kind
  resultTitle.value = title
  resultMessage.value = message
  resultOpen.value = true
}

let pendingPurchase: { tickets: TicketRecord[], event: EventRecord } | null = null

function closeResult() {
  resultOpen.value = false
  if (pendingPurchase) {
    const payload = pendingPurchase
    pendingPurchase = null
    emit('purchased', payload.tickets, payload.event)
  }
}

async function ensureHold(buyerKey: string) {
  if (!event.value || !cartItems.value.length)
    throw new Error('Nothing selected')
  if (isReserved.value) {
    status.value = 'Holding seats…'
    const hold = await api.createHold(event.value.id, {
      buyerKey,
      items: cartItems.value,
      holdId: holdId.value || undefined,
    })
    holdId.value = hold.holdId
    startHoldCountdown(hold.expiresAt)
    return hold
  }
  clearHoldLocal()
  return null
}

async function refreshSeatHold() {
  if (!event.value || !isReserved.value || !selectedSeatIds.value.length) {
    clearHoldLocal()
    return
  }
  try {
    const buyer = address.value || 'NQ07 HOLD GUEST 0000 0000 0000 0000 0000'
    const hold = await api.createHold(event.value.id, {
      buyerKey: buyer,
      items: cartItems.value,
      holdId: holdId.value || undefined,
    })
    holdId.value = hold.holdId
    startHoldCountdown(hold.expiresAt)
    status.value = ''
  }
  catch (err) {
    clearHoldLocal()
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function claimTickets(eventId: string, txHash: string, buyerAddress: string, demo = false) {
  status.value = demo ? 'Issuing tickets…' : 'Confirming payment & issuing tickets…'
  const res = await api.purchase(eventId, {
    txHash,
    buyerAddress,
    demo,
    items: cartItems.value,
    holdId: holdId.value || undefined,
    quantity: ticketCount.value,
  })
  return res.tickets?.length ? res.tickets : [res.ticket]
}

function holdError(err: unknown) {
  const msg = toErrorMessage(err)
  return /held|taken|no longer available|select seats|hold expired/i.test(msg)
}

async function buyReal() {
  if (!event.value || !canBuy.value)
    return
  error.value = ''
  status.value = ''
  loading.value = true
  try {
    status.value = providerReady.value ? 'Preparing…' : 'Connecting wallet…'
    const ok = await ensureWallet()
    if (!ok)
      throw new Error('Open GatePass inside Nimiq Pay to pay with NIM')
    const provider = await connectNimiq()
    const buyer = address.value
    if (!buyer)
      throw new Error('No Nimiq account available')

    await ensureHold(buyer)

    status.value = 'Waiting for Nimiq Pay to sync…'
    await ensureConsensus(provider)
    status.value = 'Approve payment in Nimiq Pay…'
    const txHash = await payForTicket(provider, {
      recipient: event.value.organizerAddress,
      eventId: event.value.id,
      totalLuna: totalLuna.value,
      quantity: ticketCount.value,
    })
    lastTxHash.value = txHash
    localStorage.setItem('gatepass:pendingTx', JSON.stringify({
      eventId: event.value.id,
      txHash,
      buyerAddress: buyer,
      quantity: ticketCount.value,
      items: cartItems.value,
      holdId: holdId.value,
      at: Date.now(),
    }))

    const issued = await claimTickets(event.value.id, txHash, buyer, false)
    persistTickets(issued, event.value)
    localStorage.removeItem('gatepass:pendingTx')
    clearHoldLocal()
    status.value = `Success — ${issued.length} ticket(s) ready`
    successFlash.value = true
    showResult(
      'success',
      issued.length > 1 ? 'Tickets ready' : 'Ticket ready',
      `${issued.length} pass${issued.length === 1 ? '' : 'es'} saved in Tickets.`,
    )
    pendingPurchase = { tickets: issued, event: event.value }
  }
  catch (err) {
    status.value = ''
    showResult(
      'fail',
      holdError(err) ? 'Seat not available' : 'Payment didn’t go through',
      toErrorMessage(err),
    )
  }
  finally {
    loading.value = false
  }
}

async function claimPending() {
  if (!event.value || !lastTxHash.value)
    return
  error.value = ''
  loading.value = true
  try {
    const buyer = address.value || 'NQ07 UNKNOWN'
    const issued = await claimTickets(event.value.id, lastTxHash.value, buyer, false)
    persistTickets(issued, event.value)
    localStorage.removeItem('gatepass:pendingTx')
    clearHoldLocal()
    status.value = 'Ticket(s) claimed from payment'
    successFlash.value = true
    showResult('success', 'Payment claimed', 'Your pass is in Tickets.')
    pendingPurchase = { tickets: issued, event: event.value }
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    showResult('fail', 'Couldn’t claim ticket', error.value)
  }
  finally {
    loading.value = false
  }
}

async function joinWaitlist() {
  if (!event.value)
    return
  loading.value = true
  error.value = ''
  try {
    const ok = await ensureWallet()
    if (!ok || !address.value)
      throw new Error('Connect wallet first to join waitlist')
    await api.joinWaitlist(event.value.id, address.value)
    status.value = 'Joined waitlist'
    await load()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function toggleReminder() {
  if (!event.value)
    return
  if (reminded.value) {
    clearReminder(event.value.id)
    reminded.value = false
    status.value = 'Reminder cleared'
    return
  }
  const ok = await requestNotifyPermission()
  if (!ok) {
    error.value = 'Notification permission denied — reminder saved locally; open app before the event'
  }
  setReminder(event.value.id, event.value.title, event.value.startsAt)
  reminded.value = true
  status.value = 'Reminder set for 1 hour before start'
}

const dateLabel = computed(() => {
  if (!event.value)
    return ''
  return new Date(event.value.startsAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
})

const calMonth = computed(() => {
  if (!event.value)
    return ''
  return new Date(event.value.startsAt).toLocaleDateString(undefined, { month: 'short' }).toUpperCase()
})

const calDay = computed(() => {
  if (!event.value)
    return ''
  return new Date(event.value.startsAt).toLocaleDateString(undefined, { day: 'numeric' })
})

function formatTime(d: Date) {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

const whenLabel = computed(() => {
  if (!event.value)
    return ''
  const start = new Date(event.value.startsAt)
  const end = new Date(event.value.endsAt)
  const day = start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  if (start.toDateString() === end.toDateString())
    return `${day} · ${formatTime(start)} – ${formatTime(end)}`
  return `${dateLabel.value} – ${end.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`
})

const showDescription = computed(() => {
  const d = event.value?.description?.trim() || ''
  if (!d)
    return false
  const title = event.value?.title.trim() || ''
  const venue = event.value?.venueName.trim() || ''
  const fold = (s: string) => s.replace(/\s+/g, ' ').toLowerCase()
  return fold(d) !== fold(title) && fold(d) !== fold(venue)
})

const unitPrice = computed(() => {
  if (!selectedTier.value)
    return event.value ? `${lunaToNim(event.value.priceLuna)} NIM` : '—'
  const nim = lunaToNim(selectedTier.value.priceLuna)
  return nim === 0 ? 'Free' : `${nim} NIM`
})

function bumpQty(delta: number) {
  const tier = selectedTier.value
  if (!tier)
    return
  const max = Math.min(tier.perOrderMax, tierRemaining.value ?? 20)
  const min = tier.perOrderMin
  quantity.value = Math.min(max, Math.max(min, quantity.value + delta))
}

function onSelectTier(id: string) {
  selectedTierId.value = id
  selectedSeatIds.value = []
  clearHoldLocal()
  const t = event.value?.tiers.find(x => x.id === id)
  quantity.value = Math.max(1, t?.perOrderMin || 1)
}

async function copyShare() {
  const ok = await copyToClipboard(shareUrl.value)
  status.value = ok ? 'Event link copied' : 'Could not copy — long-press to copy'
}

async function shareEvent() {
  if (!event.value)
    return
  if (navigator.share) {
    try {
      await navigator.share({
        title: event.value.title,
        text: `${event.value.title} · ${whenLabel.value} · ${event.value.venueName}`,
        url: shareUrl.value,
      })
      return
    }
    catch { /* fall through */ }
  }
  await copyShare()
}

onMounted(async () => {
  await load().catch(err => error.value = String(err))
  void probeWallet()
  invPoll = setInterval(() => void refreshInventory(), 5000)
  try {
    const pending = localStorage.getItem('gatepass:pendingTx')
    if (pending) {
      const p = JSON.parse(pending) as {
        eventId: string
        txHash: string
        quantity?: number
        items?: PurchaseItem[]
        holdId?: string
      }
      if (p.eventId === props.eventId && p.txHash) {
        lastTxHash.value = p.txHash
        if (p.quantity)
          quantity.value = p.quantity
        if (p.holdId)
          holdId.value = p.holdId
        if (p.items?.[0]?.tierId)
          selectedTierId.value = p.items[0].tierId
        if (p.items?.[0]?.seatIds)
          selectedSeatIds.value = p.items[0].seatIds
        status.value = 'Payment found — tap Claim ticket(s)'
      }
    }
  }
  catch { /* ignore */ }
})

onUnmounted(() => {
  if (invPoll)
    clearInterval(invPoll)
  if (holdTimer)
    clearInterval(holdTimer)
  if (holdDebounce)
    clearTimeout(holdDebounce)
})

watch(selectedSeatIds, () => {
  if (!isReserved.value)
    return
  if (holdDebounce)
    clearTimeout(holdDebounce)
  if (!selectedSeatIds.value.length) {
    clearHoldLocal()
    return
  }
  holdDebounce = setTimeout(() => {
    void refreshSeatHold()
  }, 450)
})

watch(address, () => {
  if (isReserved.value && selectedSeatIds.value.length)
    void refreshSeatHold()
})

watch(() => props.eventId, () => {
  void load().catch(err => error.value = String(err))
})
</script>

<template>
  <section class="detail-page">
    <ResultDialog
      :open="resultOpen"
      :kind="resultKind"
      :title="resultTitle"
      :message="resultMessage"
      :event-title="event?.title"
      :tier="purchaseTierLabel()"
      :amount="purchaseAmountLabel()"
      @close="closeResult"
    />

    <div v-if="!event" class="gp-card soft">
      <button class="gp-back" type="button" @click="emit('back')">
        ← Discover
      </button>
      <p class="gp-sub" style="margin: 0;">
        Loading event…
      </p>
    </div>

    <template v-else>
      <div class="detail">
        <div class="detail__nav">
          <button class="gp-back" type="button" @click="emit('back')">
            ← Discover
          </button>
          <div class="detail__nav-actions">
            <button class="detail-link" type="button" @click="shareEvent">
              Share
            </button>
            <button class="detail-link" type="button" @click="toggleReminder">
              {{ reminded ? 'Reminder on' : 'Remind' }}
            </button>
          </div>
        </div>

        <div class="detail__hero">
          <div class="detail__cal" aria-hidden="true">
            <span class="detail__cal-month">{{ calMonth }}</span>
            <span class="detail__cal-day">{{ calDay }}</span>
          </div>
          <div class="detail__heading">
            <div v-if="event.hallSlotId || event.soldOut || isPast" class="gp-chip-row">
              <span v-if="event.hallSlotId" class="gp-pill gold">Nimiq Hall</span>
              <span v-if="event.soldOut" class="gp-pill warn">Sold out</span>
              <span v-else-if="isPast" class="gp-pill warn">Ended</span>
            </div>
            <h1 class="gp-page-title">
              {{ event.title }}
            </h1>
          </div>
        </div>

        <dl class="detail__meta">
          <div>
            <dt>When</dt>
            <dd>{{ whenLabel }}</dd>
          </div>
          <div>
            <dt>Where</dt>
            <dd>
              <span>{{ event.venueName }}</span>
              <a
                v-if="event.venueLat != null && event.venueLng != null"
                class="detail-link"
                :href="mapsUrl(event.venueLat, event.venueLng)"
                target="_blank"
                rel="noopener"
              >Map</a>
            </dd>
          </div>
          <div v-if="showDescription">
            <dt>About</dt>
            <dd>{{ event.description }}</dd>
          </div>
        </dl>

        <p class="detail__facts">
          <span>{{ unitPrice }}{{ event.tiers.length > 1 ? ' from' : '' }}</span>
          <span>{{ selectedTier?.remaining != null ? selectedTier.remaining : (event.remaining != null ? event.remaining : '∞') }} left</span>
          <span v-if="!event.hideSoldCount">{{ event.soldCount }} going</span>
          <span v-if="!event.hideRedeemedCount">{{ event.redeemedCount }} in</span>
        </p>

        <div v-if="!isPast && !event.soldOut && !lastTxHash" class="detail__purchase">
          <label class="gp-label">Ticket type</label>
          <TierPicker
            :tiers="event.tiers"
            :selected-id="selectedTierId"
            @select="onSelectTier"
          />

          <SeatMap
            v-if="isReserved && selectedTierId"
            v-model="selectedSeatIds"
            :event-id="event.id"
            :tier-id="selectedTierId"
          />
          <p v-if="holdLabel" class="gp-banner ok" style="margin-top: 8px;">
            {{ holdLabel }}
          </p>

          <template v-else-if="selectedTier && !isReserved">
            <label class="gp-label">Quantity</label>
            <div class="gp-qty">
              <button type="button" :disabled="quantity <= selectedTier.perOrderMin" @click="bumpQty(-1)">
                −
              </button>
              <strong>{{ quantity }}</strong>
              <button
                type="button"
                :disabled="tierRemaining != null && quantity >= Math.min(selectedTier.perOrderMax, tierRemaining)"
                @click="bumpQty(1)"
              >
                +
              </button>
            </div>
          </template>

        </div>

        <details class="gp-details">
          <summary>Payment details</summary>
          <div class="gp-banner">
            <div class="gp-mono">
              Organizer {{ event.organizerAddress }}
            </div>
            <div class="gp-mono" style="margin-top: 6px;">
              Memo {{ paymentMemo(event.id, ticketCount) }}
            </div>
            <div v-if="event.waitlistCount" class="gp-mono" style="margin-top: 6px;">
              {{ event.waitlistCount }} on waitlist
            </div>
            <div v-if="address" class="gp-mono" style="margin-top: 6px;">
              Paying as {{ address }}
            </div>
          </div>
        </details>
      </div>

      <p v-if="isPast" class="gp-error">
        This event has ended.
      </p>
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
      <p v-if="lastTxHash" class="gp-mono">
        tx {{ lastTxHash }}
      </p>

      <div v-if="!isPast" class="gp-sticky-cta gp-sticky-cta--compact">
        <p v-if="providerReady && address" class="cta-wallet">
          {{ address.replace(/\s+/g, '').slice(0, 6) }}…{{ address.replace(/\s+/g, '').slice(-4) }}
        </p>

        <button
          v-if="lastTxHash"
          class="gp-btn"
          :disabled="loading"
          type="button"
          @click="claimPending"
        >
          {{ loading ? 'Claiming…' : 'Claim ticket(s)' }}
        </button>

        <button
          v-else-if="!event.soldOut"
          class="gp-btn"
          :disabled="loading || !canBuy"
          type="button"
          @click="buyReal"
        >
          {{ loading ? 'Processing…' : payLabel }}
        </button>
        <button
          v-else
          class="gp-btn"
          :disabled="loading"
          type="button"
          @click="joinWaitlist"
        >
          Join waitlist
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.detail-page {
  padding-bottom: calc(var(--gp-tabbar-h) + env(safe-area-inset-bottom, 0px) + 88px);
}

.detail__nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -4px 0 8px;
}

.detail__nav .gp-back {
  padding: 12px 0;
}

.detail__nav-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.detail-link {
  border: 0;
  background: transparent;
  color: var(--gp-muted);
  font-size: 0.82rem;
  font-weight: 500;
  min-height: 40px;
  padding: 8px 10px;
  text-decoration: none;
}

.detail__hero {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  margin-bottom: 16px;
}

.detail__cal {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 64px;
  padding: 8px 4px;
  border-radius: 16px;
  background: rgba(233, 178, 19, 0.18);
  color: var(--gp-navy);
}

.detail__cal-month {
  font-size: 0.62rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: #8a6a00;
}

.detail__cal-day {
  font-size: 1.45rem;
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1;
}

.detail__heading .gp-chip-row {
  margin: 0 0 6px;
}

.detail__heading .gp-page-title {
  margin: 0;
  font-size: 1.45rem;
}

.detail__meta {
  margin: 0 0 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail__meta > div {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}

.detail__meta dt {
  margin: 0;
  padding-top: 1px;
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--gp-muted);
}

.detail__meta dd {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  font-size: 0.92rem;
  font-weight: 500;
  line-height: 1.35;
  color: var(--gp-navy);
}

.detail__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 0 0 4px;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--gp-muted);
}

.detail__purchase {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--gp-border);
}

.cta-wallet {
  margin: 0 0 8px;
  text-align: center;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--gp-muted);
  font-family: var(--gp-mono);
}
</style>
