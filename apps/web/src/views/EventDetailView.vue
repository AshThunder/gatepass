<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import TierPicker from '@/components/TierPicker.vue'
import SeatMap from '@/components/SeatMap.vue'
import { connectNimiq, isDemoAllowed, payForTicket } from '@/nimiq/wallet'
import { useWallet } from '@/nimiq/useWallet'
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
const reminded = ref(false)
const successFlash = ref(false)
let invPoll: ReturnType<typeof setInterval> | null = null

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
  let list: Array<{ ticket: TicketRecord, event: EventRecord }> = []
  try {
    list = raw ? JSON.parse(raw) as typeof list : []
  }
  catch { list = [] }
  for (const t of tickets) {
    list = list.filter(x => x.ticket.id !== t.id)
    list.unshift({ ticket: t, event: ev })
  }
  localStorage.setItem('gatepass:myTickets', JSON.stringify(list.slice(0, 40)))
  if (tickets[0])
    localStorage.setItem('gatepass:myTicket', JSON.stringify({ ticket: tickets[0], event: ev }))
}

async function ensureHold(buyerKey: string) {
  if (!event.value || !cartItems.value.length)
    throw new Error('Nothing selected')
  if (isReserved.value) {
    status.value = 'Holding seats…'
    const hold = await api.createHold(event.value.id, {
      buyerKey,
      items: cartItems.value,
    })
    holdId.value = hold.holdId
    return hold
  }
  holdId.value = null
  return null
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
    holdId.value = null
    status.value = `Success — ${issued.length} ticket(s) ready`
    successFlash.value = true
    emit('purchased', issued, event.value)
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    status.value = ''
  }
  finally {
    loading.value = false
  }
}

async function buyDemo() {
  if (!event.value || !isDemoAllowed() || !canBuy.value)
    return
  error.value = ''
  loading.value = true
  try {
    const buyer = address.value || 'NQ07 DEMO BUYER 0000 0000 0000 0000 0000'
    await ensureHold(buyer)
    const txHash = `demo-${crypto.randomUUID()}`
    const issued = await claimTickets(event.value.id, txHash, buyer, true)
    persistTickets(issued, event.value)
    holdId.value = null
    status.value = `Success — ${issued.length} demo ticket(s)`
    successFlash.value = true
    emit('purchased', issued, event.value)
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
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
    holdId.value = null
    status.value = 'Ticket(s) claimed from payment'
    successFlash.value = true
    emit('purchased', issued, event.value)
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
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
  holdId.value = null
  const t = event.value?.tiers.find(x => x.id === id)
  quantity.value = Math.max(1, t?.perOrderMin || 1)
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
})

watch(() => props.eventId, () => {
  void load().catch(err => error.value = String(err))
})
</script>

<template>
  <section class="detail-page">
    <button class="gp-back" type="button" @click="emit('back')">
      ← Discover
    </button>

    <div v-if="successFlash" class="gp-toast" role="status">
      <span class="gp-pill ok">Purchase complete</span>
      <p class="gp-sub" style="margin: 8px 0 0;">
        Your ticket(s) are in the Tickets tab.
      </p>
    </div>

    <div v-if="!event" class="gp-card soft">
      <p class="gp-sub" style="margin: 0;">
        Loading event…
      </p>
    </div>

    <template v-else>
      <div class="gp-card flush detail">
        <div
          class="cover"
          :class="{ placeholder: !event.coverUrl }"
          :style="event.coverUrl ? { backgroundImage: `url(${event.coverUrl})` } : undefined"
        />
        <div class="detail__body">
          <div class="gp-chip-row">
            <span class="gp-pill">{{ dateLabel }}</span>
            <span v-if="event.soldOut" class="gp-pill warn">Sold out</span>
            <span v-else-if="isPast" class="gp-pill warn">Ended</span>
            <span v-else class="gp-pill ok">{{ unitPrice }}</span>
          </div>
          <h1 class="gp-page-title">
            {{ event.title }}
          </h1>
          <p class="gp-page-sub" style="margin-bottom: 8px;">
            {{ event.venueName }}
          </p>
          <p v-if="event.description" class="gp-sub">
            {{ event.description }}
          </p>

          <div class="gp-stat-grid">
            <div class="gp-stat">
              <strong>{{ unitPrice }}</strong>
              <span>{{ event.tiers.length > 1 ? 'from' : 'each' }}</span>
            </div>
            <div class="gp-stat">
              <strong>{{ selectedTier?.remaining != null ? selectedTier.remaining : (event.remaining != null ? event.remaining : '∞') }}</strong>
              <span>{{ event.soldOut ? 'sold out' : 'left' }}</span>
            </div>
            <div v-if="!event.hideSoldCount" class="gp-stat">
              <strong>{{ event.soldCount }}</strong>
              <span>going</span>
            </div>
            <div v-else class="gp-stat">
              <strong>{{ event.tiers.length }}</strong>
              <span>tier{{ event.tiers.length === 1 ? '' : 's' }}</span>
            </div>
            <div v-if="!event.hideRedeemedCount" class="gp-stat">
              <strong>{{ event.redeemedCount }}</strong>
              <span>checked in</span>
            </div>
          </div>

          <div class="gp-row" style="margin-bottom: 4px;">
            <button class="gp-btn ghost sm" type="button" @click="copyShare">
              Share
            </button>
            <button class="gp-btn ghost sm" type="button" @click="toggleReminder">
              {{ reminded ? 'Reminder on' : 'Remind me' }}
            </button>
            <a
              v-if="event.venueLat != null && event.venueLng != null"
              class="gp-btn ghost sm"
              :href="mapsUrl(event.venueLat, event.venueLng)"
              target="_blank"
              rel="noopener"
            >Map</a>
          </div>

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

            <details v-if="isDemoAllowed()" class="gp-details">
              <summary>More options</summary>
              <button
                class="gp-btn ghost sm"
                :disabled="loading || !canBuy"
                type="button"
                @click="buyDemo"
              >
                Get demo ticket(s)
              </button>
            </details>
          </div>

          <details class="gp-details">
            <summary>Payment details</summary>
            <div class="gp-banner">
              <div class="gp-mono">Organizer {{ event.organizerAddress }}</div>
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
      </div>

      <p v-if="isPast" class="gp-error">
        This event has ended.
      </p>
      <p v-if="status" class="gp-success">
        {{ status }}
      </p>
      <p v-if="error" class="gp-error">
        {{ error }}
      </p>
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
  /* Room to scroll past the compact pay bar + tab bar */
  padding-bottom: calc(var(--gp-tabbar-h) + env(safe-area-inset-bottom, 0px) + 88px);
}

.detail__body {
  padding: 16px 18px 18px;
}

.detail__purchase {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--gp-border);
}

.cover {
  height: 168px;
  background-size: cover;
  background-position: center;
  background-color: #dde1ef;
}
.cover.placeholder {
  background: linear-gradient(145deg, #252a55 0%, #1f2348 55%, #151833 100%);
}
.cta-wallet {
  margin: 0 0 8px;
  text-align: center;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--gp-muted);
  font-family: var(--gp-mono);
}
</style>
