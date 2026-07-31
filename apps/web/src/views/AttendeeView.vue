<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import AttendanceBadge from '@/components/AttendanceBadge.vue'
import RotatingTicketQr from '@/components/RotatingTicketQr.vue'
import {
  connectNimiq,
  tryConnectNimiq,
  isDemoAllowed,
  listAccounts,
  payForTicket,
} from '@/nimiq/wallet'
import {
  type EventRecord,
  type TicketRecord,
  isBadgePhase,
  lunaToNim,
  paymentMemo,
} from '@gatepass/shared'

const events = ref<EventRecord[]>([])
const selectedId = ref('')
const address = ref('')
const ticket = ref<TicketRecord | null>(null)
const eventForTicket = ref<EventRecord | null>(null)
const loading = ref(false)
const error = ref('')
const status = ref('')
const walletMessage = ref('Open inside Nimiq Pay to connect your wallet.')
const providerReady = ref(false)
const networkLabel = ref('')
const lastTxHash = ref('')

const selected = computed(() => events.value.find(e => e.id === selectedId.value) || null)

const showBadge = computed(() => {
  if (!ticket.value || !eventForTicket.value)
    return false
  return ticket.value.status === 'redeemed' && isBadgePhase(eventForTicket.value.endsAt)
})

const payLabel = computed(() => {
  if (!selected.value)
    return 'Pay with NIM'
  return `Pay ${lunaToNim(selected.value.priceLuna)} NIM`
})

async function loadEvents() {
  const res = await api.listEvents()
  events.value = res.events
  if (!selectedId.value && res.events[0])
    selectedId.value = res.events[0].id
}

async function loadNetwork() {
  try {
    const net = await api.network()
    networkLabel.value = net.reachable
      ? `${net.network} · block ${net.blockNumber} · ≥${net.minConfirmations} conf`
      : `${net.network} · RPC unreachable`
  }
  catch {
    networkLabel.value = 'network status unavailable'
  }
}

async function applyBuyer(provider: Awaited<ReturnType<typeof connectNimiq>>) {
  const accounts = await listAccounts(provider)
  address.value = accounts[0] || ''
  providerReady.value = !!address.value
  walletMessage.value = address.value
    ? `Connected ${address.value}`
    : 'Wallet connected — no account returned'
}

async function probeWallet() {
  const provider = await tryConnectNimiq()
  if (!provider)
    return
  try {
    await applyBuyer(provider)
  }
  catch {
    // leave disconnected
  }
}

async function connect() {
  try {
    status.value = 'Connecting…'
    await applyBuyer(await connectNimiq())
    status.value = ''
  }
  catch (err) {
    providerReady.value = false
    walletMessage.value = err instanceof Error ? err.message : String(err)
    status.value = ''
  }
}

function restoreTicket() {
  const raw = localStorage.getItem('gatepass:myTicket')
  if (!raw)
    return
  try {
    const parsed = JSON.parse(raw) as { ticket: TicketRecord, event: EventRecord }
    ticket.value = parsed.ticket
    eventForTicket.value = parsed.event
  }
  catch {
    // ignore
  }
}

function persistTicket(t: TicketRecord, ev: EventRecord) {
  localStorage.setItem('gatepass:myTicket', JSON.stringify({ ticket: t, event: ev }))
}

async function claimTicket(eventId: string, txHash: string, buyerAddress: string, demo = false) {
  status.value = demo
    ? 'Issuing demo ticket…'
    : 'Waiting for chain confirmation & issuing ticket…'
  const res = await api.purchase(eventId, {
    txHash,
    buyerAddress,
    demo,
  })
  return res.ticket
}

async function buyReal() {
  error.value = ''
  status.value = ''
  lastTxHash.value = ''
  if (!selected.value)
    return
  if (!providerReady.value)
    throw new Error('Open this Mini App inside Nimiq Pay to pay with NIM.')

  loading.value = true
  try {
    const provider = await connectNimiq()
    status.value = 'Requesting account…'
    let buyer = address.value
    if (!buyer) {
      const accounts = await listAccounts(provider)
      buyer = accounts[0] || ''
      address.value = buyer
    }
    if (!buyer)
      throw new Error('No Nimiq account available')

    status.value = `Approve ${lunaToNim(selected.value.priceLuna)} NIM payment in Nimiq Pay…`
    const txHash = await payForTicket(provider, {
      recipient: selected.value.organizerAddress,
      priceLuna: selected.value.priceLuna,
      eventId: selected.value.id,
    })
    lastTxHash.value = txHash
    localStorage.setItem('gatepass:pendingTx', JSON.stringify({
      eventId: selected.value.id,
      txHash,
      buyerAddress: buyer,
      at: Date.now(),
    }))

    const issued = await claimTicket(selected.value.id, txHash, buyer, false)
    ticket.value = issued
    eventForTicket.value = selected.value
    persistTicket(issued, selected.value)
    localStorage.removeItem('gatepass:pendingTx')
    status.value = 'Ticket issued'
    walletMessage.value = `Paid from ${buyer}`
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
  error.value = ''
  status.value = ''
  if (!selected.value || !isDemoAllowed())
    return
  loading.value = true
  try {
    const buyer = address.value || 'NQ07 DEMO BUYER 0000 0000 0000 0000 0000'
    const txHash = `demo-${crypto.randomUUID()}`
    const issued = await claimTicket(selected.value.id, txHash, buyer, true)
    ticket.value = issued
    eventForTicket.value = selected.value
    persistTicket(issued, selected.value)
    status.value = 'Demo ticket issued (no chain payment)'
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    status.value = ''
  }
  finally {
    loading.value = false
  }
}

async function resumePendingClaim() {
  const raw = localStorage.getItem('gatepass:pendingTx')
  if (!raw)
    return
  try {
    const pending = JSON.parse(raw) as {
      eventId: string
      txHash: string
      buyerAddress: string
    }
    status.value = 'Resuming ticket claim for pending payment…'
    loading.value = true
    const issued = await claimTicket(pending.eventId, pending.txHash, pending.buyerAddress, false)
    const ev = events.value.find(e => e.id === pending.eventId)
      || (await api.getEvent(pending.eventId)).event
    ticket.value = issued
    eventForTicket.value = ev
    persistTicket(issued, ev)
    lastTxHash.value = pending.txHash
    localStorage.removeItem('gatepass:pendingTx')
    status.value = 'Ticket issued from pending payment'
  }
  catch (err) {
    // Keep pendingTx so user can retry
    error.value = err instanceof Error
      ? `Pending payment not claimed yet: ${err.message}`
      : String(err)
    status.value = ''
  }
  finally {
    loading.value = false
  }
}

async function refreshTicketStatus() {
  if (!ticket.value)
    return
  try {
    const res = await api.getTicket(ticket.value.id)
    ticket.value = res.ticket
    if (eventForTicket.value)
      persistTicket(res.ticket, eventForTicket.value)
  }
  catch {
    // offline ok
  }
}

onMounted(async () => {
  restoreTicket()
  await Promise.all([
    loadEvents().catch(err => error.value = String(err)),
    loadNetwork(),
    probeWallet(),
  ])
  await refreshTicketStatus()
  if (!ticket.value)
    await resumePendingClaim()
})

watch(selectedId, () => {
  error.value = ''
  status.value = ''
})
</script>

<template>
  <section>
    <div class="gp-card">
      <h1 class="gp-h1">
        Tickets
      </h1>
      <p class="gp-sub">
        Pay with NIM in Nimiq Pay. Memo <span class="gp-mono">GATEPASS:&lt;eventId&gt;</span> is attached automatically; the API waits for on-chain confirmation before issuing your rotating QR.
      </p>
      <div class="gp-banner">
        <div>{{ walletMessage }}</div>
        <div v-if="networkLabel" class="gp-mono" style="margin-top: 6px;">
          {{ networkLabel }}
        </div>
      </div>

      <label class="gp-label">Event</label>
      <select v-model="selectedId" class="gp-input">
        <option disabled value="">
          Select an event
        </option>
        <option v-for="ev in events" :key="ev.id" :value="ev.id">
          {{ ev.title }} — {{ lunaToNim(ev.priceLuna) }} NIM
        </option>
      </select>

      <div v-if="selected" class="gp-banner">
        <strong>{{ selected.venueName }}</strong><br>
        {{ new Date(selected.startsAt).toLocaleString() }} → {{ new Date(selected.endsAt).toLocaleString() }}
        <div class="gp-mono" style="margin-top: 6px;">
          Pay to {{ selected.organizerAddress }}
        </div>
        <div class="gp-mono" style="margin-top: 4px;">
          Memo {{ paymentMemo(selected.id) }}
        </div>
      </div>

      <p v-if="status" class="gp-success">
        {{ status }}
      </p>
      <p v-if="error" class="gp-error">
        {{ error }}
      </p>
      <p v-if="lastTxHash" class="gp-mono">
        tx {{ lastTxHash }}
      </p>

      <button
        class="gp-btn"
        :disabled="loading || !selected || !providerReady"
        @click="buyReal"
      >
        {{ loading && providerReady ? 'Processing payment…' : payLabel }}
      </button>

      <button
        v-if="isDemoAllowed()"
        class="gp-btn ghost"
        style="margin-top: 8px;"
        :disabled="loading || !selected"
        @click="buyDemo"
      >
        Get demo ticket (no chain)
      </button>

      <button
        v-if="!providerReady"
        class="gp-btn secondary"
        style="margin-top: 8px;"
        :disabled="loading"
        @click="connect"
      >
        Retry Nimiq Pay connect
      </button>
    </div>

    <div v-if="ticket && eventForTicket && showBadge" class="gp-card">
      <AttendanceBadge :event="eventForTicket" :ticket="ticket" />
    </div>

    <div v-else-if="ticket && eventForTicket" class="gp-card">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
        <h2 class="gp-h1" style="font-size: 1.15rem; margin: 0;">
          {{ eventForTicket.title }}
        </h2>
        <span class="gp-pill" :class="ticket.status === 'redeemed' ? 'ok' : ''">
          {{ ticket.status }}
        </span>
      </div>
      <p class="gp-sub">
        Show this at the gate. Code refreshes automatically.
      </p>
      <RotatingTicketQr
        :event-id="ticket.eventId"
        :ticket-id="ticket.id"
        :ticket-seed="ticket.ticketSeed"
      />
      <button class="gp-btn ghost" style="margin-top: 12px;" @click="refreshTicketStatus">
        Refresh status
      </button>
    </div>
  </section>
</template>
