<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import AttendanceBadge from '@/components/AttendanceBadge.vue'
import RotatingTicketQr from '@/components/RotatingTicketQr.vue'
import FlashBanner from '@/components/FlashBanner.vue'
import ResultDialog from '@/components/ResultDialog.vue'
import { claimPendingTx, readPendingTx } from '@/lib/claimPending'
import {
  type Contact,
  findContactByAddress,
  listContacts,
  removeContact,
  upsertContact,
} from '@/lib/contacts'
import { appendSent, listSent, mergeOutbox, type SentRow } from '@/lib/sentTickets'
import { demoInboxSession, ensureInboxSession } from '@/lib/session'
import { isDemoAllowed } from '@/nimiq/wallet'
import { useWallet } from '@/nimiq/useWallet'
import {
  type EventRecord,
  type TicketRecord,
  isBadgePhase,
  isNqAddress,
} from '@gatepass/shared'

interface Stored {
  ticket: TicketRecord
  event: EventRecord
  origin?: 'purchased' | 'received'
}

interface EventGroup {
  eventId: string
  event: EventRecord
  tickets: Stored[]
  readyCount: number
  redeemedCount: number
  cancelledCount: number
}

type InboxTab = 'ready' | 'sent' | 'received'
type Filter = 'ready' | 'all'

const emit = defineEmits<{ browse: [] }>()
const props = defineProps<{
  visit?: number
  active?: boolean
}>()
const { address: walletAddress, ready: walletReady } = useWallet()

const items = ref<Stored[]>([])
const sentItems = ref<SentRow[]>([])
const contacts = ref<Contact[]>([])
const selectedEventId = ref<string | null>(null)
const activeId = ref('')
const error = ref('')
const status = ref('')
const previewBadge = ref(false)
const loading = ref(false)
const inboxTab = ref<InboxTab>('ready')
const showContacts = ref(false)
const filter = ref<Filter>('ready')
const showVoided = ref(false)
const showTools = ref(false)
const animKey = ref(0)
const recoverMsg = ref('')
const sendOpen = ref(false)
const sendTo = ref('')
const sendContactId = ref('')
const contactName = ref('')
const contactAddress = ref('')
const contactEditId = ref('')
const demoReceiveAs = ref('')
const skipVerify = ref(false)
const resultOpen = ref(false)
const resultKind = ref<'success' | 'fail'>('success')
const resultTitle = ref('')
const resultMessage = ref('')
const resultEvent = ref('')
const resultTier = ref('')

const liveItems = computed(() => {
  if (inboxTab.value === 'received')
    return items.value.filter(i => i.origin === 'received')
  return items.value.filter(i => i.origin !== 'received')
})

const eventGroups = computed((): EventGroup[] => {
  const map = new Map<string, EventGroup>()
  for (const item of liveItems.value) {
    const id = item.event.id || item.ticket.eventId
    let g = map.get(id)
    if (!g) {
      g = {
        eventId: id,
        event: item.event,
        tickets: [],
        readyCount: 0,
        redeemedCount: 0,
        cancelledCount: 0,
      }
      map.set(id, g)
    }
    g.tickets.push(item)
    if (item.ticket.status === 'valid')
      g.readyCount++
    else if (item.ticket.status === 'redeemed')
      g.redeemedCount++
    else
      g.cancelledCount++
  }
  return [...map.values()].sort(
    (a, b) => +new Date(a.event.startsAt) - +new Date(b.event.startsAt),
  )
})

const selectedGroup = computed(() =>
  eventGroups.value.find(g => g.eventId === selectedEventId.value) || null,
)

const eventTickets = computed(() => {
  if (!selectedGroup.value)
    return [] as Stored[]
  const rank = (s: string) => (s === 'valid' ? 0 : s === 'redeemed' ? 1 : 2)
  return [...selectedGroup.value.tickets].sort((a, b) => {
    const d = rank(a.ticket.status) - rank(b.ticket.status)
    if (d !== 0)
      return d
    return +new Date(b.ticket.createdAt) - +new Date(a.ticket.createdAt)
  })
})

const filtered = computed(() => {
  if (filter.value === 'ready')
    return eventTickets.value.filter(i => i.ticket.status === 'valid')
  if (!showVoided.value)
    return eventTickets.value.filter(i => i.ticket.status !== 'cancelled')
  return eventTickets.value
})

const voidedInEvent = computed(() =>
  eventTickets.value.filter(i => i.ticket.status === 'cancelled').length,
)

const activeIndex = computed(() =>
  filtered.value.findIndex(i => i.ticket.id === activeId.value),
)

const active = computed(() => {
  if (activeIndex.value >= 0)
    return filtered.value[activeIndex.value]!
  return filtered.value[0] || eventTickets.value[0] || null
})

const showBadge = computed(() => {
  if (!active.value)
    return false
  if (previewBadge.value)
    return true
  return active.value.ticket.status === 'redeemed'
    && isBadgePhase(active.value.event.endsAt)
})

const whenLabel = computed(() => {
  if (!active.value)
    return ''
  return new Date(active.value.event.startsAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
})

const dateParts = computed(() => {
  if (!active.value)
    return { day: '—', month: '', time: '' }
  const d = new Date(active.value.event.startsAt)
  return {
    day: String(d.getDate()),
    month: d.toLocaleString(undefined, { month: 'short' }).toUpperCase(),
    time: d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' }),
  }
})

const readyInEvent = computed(() => selectedGroup.value?.readyCount ?? 0)
const canPrev = computed(() => activeIndex.value > 0)
const canNext = computed(() => activeIndex.value >= 0 && activeIndex.value < filtered.value.length - 1)

const viewingPass = computed(() => !!selectedEventId.value && !showContacts.value)

const needsPassFilter = computed(() => {
  const g = selectedGroup.value
  if (!g)
    return false
  return g.tickets.length > 1 || g.redeemedCount > 0 || g.cancelledCount > 0
})

function formatEventWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function showResult(
  kind: 'success' | 'fail',
  title: string,
  message: string,
  eventTitle = '',
  tier = '',
) {
  resultKind.value = kind
  resultTitle.value = title
  resultMessage.value = message
  resultEvent.value = eventTitle
  resultTier.value = tier
  resultOpen.value = true
}

function shortAddr(addr: string) {
  const n = addr.replace(/\s+/g, '')
  if (n.length < 12)
    return addr
  return `${n.slice(0, 6)}…${n.slice(-4)}`
}

function reloadContacts() {
  contacts.value = listContacts()
}

function reloadSent() {
  sentItems.value = listSent()
}

function persist() {
  localStorage.setItem('gatepass:myTickets', JSON.stringify(items.value))
  if (active.value)
    localStorage.setItem('gatepass:myTicket', JSON.stringify(active.value))
}

function pickDefaultId(list: Stored[]) {
  const valid = list.find(i => i.ticket.status === 'valid')
  return (valid || list[0])?.ticket.id || ''
}

function loadLocal() {
  const multi = localStorage.getItem('gatepass:myTickets')
  if (multi) {
    try {
      items.value = JSON.parse(multi) as Stored[]
    }
    catch { items.value = [] }
  }
  else {
    const single = localStorage.getItem('gatepass:myTicket')
    if (single) {
      try {
        items.value = [JSON.parse(single) as Stored]
      }
      catch { items.value = [] }
    }
  }

  reloadContacts()
  reloadSent()
  selectedEventId.value = null
  const pending = localStorage.getItem('gatepass:pendingOpenEvent')
  if (pending && eventGroups.value.some(g => g.eventId === pending)) {
    localStorage.removeItem('gatepass:pendingOpenEvent')
    openEvent(pending)
  }
}

function setInboxTab(tab: InboxTab) {
  inboxTab.value = tab
  showContacts.value = false
  selectedEventId.value = null
  previewBadge.value = false
  showTools.value = false
  error.value = ''
  status.value = ''
}

function openEvent(eventId: string) {
  selectedEventId.value = eventId
  const group = eventGroups.value.find(g => g.eventId === eventId)
  if (!group)
    return
  filter.value = group.readyCount > 0 ? 'ready' : 'all'
  activeId.value = pickDefaultId(group.tickets)
  previewBadge.value = false
  showTools.value = false
  error.value = ''
  status.value = ''
  void bumpAnim()
}

function backToEvents() {
  selectedEventId.value = null
  previewBadge.value = false
  showTools.value = false
  showContacts.value = false
  inboxTab.value = 'ready'
  error.value = ''
  status.value = ''
}

async function bumpAnim() {
  animKey.value += 1
  await nextTick()
}

function selectByIndex(i: number) {
  const item = filtered.value[i]
  if (!item)
    return
  activeId.value = item.ticket.id
  previewBadge.value = false
  showTools.value = false
  error.value = ''
  status.value = ''
  void bumpAnim()
}

function prev() {
  if (canPrev.value)
    selectByIndex(activeIndex.value - 1)
}

function next() {
  if (canNext.value)
    selectByIndex(activeIndex.value + 1)
}

function setFilter(nextFilter: Filter) {
  filter.value = nextFilter
  const list = nextFilter === 'ready'
    ? eventTickets.value.filter(i => i.ticket.status === 'valid')
    : eventTickets.value
  if (!list.some(i => i.ticket.id === activeId.value))
    activeId.value = list[0]?.ticket.id || ''
  void bumpAnim()
}

async function refreshActive() {
  if (!active.value)
    return
  const id = active.value.ticket.id
  try {
    const res = await api.getTicket(id)
    const idx = items.value.findIndex(i => i.ticket.id === res.ticket.id)
    if (idx >= 0)
      items.value[idx]!.ticket = res.ticket
    persist()
    error.value = ''
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not found|404/i.test(msg)) {
      items.value = items.value.filter(i => i.ticket.id !== id)
      persist()
      if (activeId.value === id)
        activeId.value = filtered.value[0]?.ticket.id || eventTickets.value[0]?.ticket.id || ''
      if (!eventTickets.value.length)
        selectedEventId.value = null
      error.value = 'That ticket is gone — removed from this device'
    }
    else {
      error.value = msg
    }
  }
}

function openSend() {
  if (!active.value || active.value.ticket.status !== 'valid')
    return
  sendContactId.value = contacts.value[0]?.id || ''
  sendTo.value = contacts.value[0]?.address || ''
  sendOpen.value = true
  error.value = ''
}

function onPickContact(id: string) {
  sendContactId.value = id
  const c = contacts.value.find(x => x.id === id)
  sendTo.value = c?.address || sendTo.value
}

function onSendContactChange(ev: Event) {
  onPickContact((ev.target as HTMLSelectElement).value)
}

async function confirmSend() {
  if (!active.value)
    return
  const to = sendTo.value.trim()
  if (!isNqAddress(to)) {
    showResult('fail', 'Couldn’t send', 'Enter a valid NQ address or pick a contact.', active.value.event.title, active.value.ticket.tierName || '')
    return
  }
  loading.value = true
  try {
    const res = await api.transferTicket(
      active.value.ticket.id,
      to,
      active.value.ticket.buyerAddress,
    )
    items.value = items.value.filter(i => i.ticket.id !== res.cancelledTicketId)
    appendSent({
      transfer: res.transfer,
      contactName: findContactByAddress(to)?.name || null,
    })
    reloadSent()
    persist()
    sendOpen.value = false
    showTools.value = false
    selectedEventId.value = null
    inboxTab.value = 'sent'
    showResult(
      'success',
      'Pass sent',
      `Forwarded to ${findContactByAddress(to)?.name || shortAddr(to)}.`,
      res.transfer.eventTitle,
      res.transfer.tierName || '',
    )
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    showResult('fail', 'Couldn’t send', msg, active.value.event.title, active.value.ticket.tierName || '')
  }
  finally {
    loading.value = false
  }
}

function saveContact() {
  try {
    upsertContact({
      id: contactEditId.value || undefined,
      name: contactName.value,
      address: contactAddress.value,
    })
    contactName.value = ''
    contactAddress.value = ''
    contactEditId.value = ''
    reloadContacts()
    status.value = 'Contact saved'
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function editContact(c: Contact) {
  contactEditId.value = c.id
  contactName.value = c.name
  contactAddress.value = c.address
}

function deleteContact(id: string) {
  removeContact(id)
  reloadContacts()
}

let inboxSync: Promise<void> | null = null

async function syncInbox(forceDemoAddress?: string) {
  const addr = forceDemoAddress || walletAddress.value
  if (!addr)
    return
  if (!forceDemoAddress && inboxSync)
    return inboxSync
  const run = doSyncInbox(addr, forceDemoAddress)
  if (!forceDemoAddress)
    inboxSync = run.finally(() => { inboxSync = null })
  return run
}

async function doSyncInbox(addr: string, forceDemoAddress?: string) {
  loading.value = true
  try {
    const session = forceDemoAddress
      ? await demoInboxSession(forceDemoAddress)
      : await ensureInboxSession(addr)
    const inbox = await api.ticketInbox(session.token)
    let added = 0
    for (const row of inbox.tickets) {
      if (items.value.some(i => i.ticket.id === row.ticket.id))
        continue
      items.value.unshift({ ticket: row.ticket, event: row.event, origin: 'received' })
      added++
    }
    persist()
    try {
      const out = await api.ticketOutbox(session.token)
      mergeOutbox(out.transfers.map(transfer => ({
        transfer,
        contactName: findContactByAddress(transfer.toAddress)?.name || null,
      })))
      reloadSent()
    }
    catch {
      // outbox is optional
    }
    if (added)
      status.value = `Received ${added} pass${added === 1 ? '' : 'es'}`
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

async function pullDemoInbox() {
  const addr = demoReceiveAs.value.trim() || contacts.value[0]?.address || ''
  if (!addr) {
    error.value = 'Pick a contact or paste the friend’s NQ address'
    return
  }
  inboxTab.value = 'received'
  showContacts.value = false
  await syncInbox(addr)
}

watch(activeId, () => {
  if (selectedEventId.value)
    void refreshActive()
})

watch(filtered, (list) => {
  if (!selectedEventId.value || !list.length)
    return
  if (!list.some(i => i.ticket.id === activeId.value))
    activeId.value = list[0]!.ticket.id
})

watch(
  [() => props.active, walletReady, walletAddress],
  ([active, ready, addr]) => {
    if (active && ready && addr)
      void syncInbox()
  },
  { immediate: true },
)

watch(() => props.visit, (_n, prev) => {
  if (prev !== undefined)
    backToEvents()
})

onMounted(async () => {
  loadLocal()
  try {
    skipVerify.value = (await api.network()).skipTxVerify
  }
  catch {
    skipVerify.value = false
  }
  if (readPendingTx()) {
    recoverMsg.value = 'Checking a previous payment…'
    const res = await claimPendingTx()
    if (res.ok) {
      loadLocal()
      recoverMsg.value = 'Payment recovered — tickets updated'
      setTimeout(() => {
        recoverMsg.value = ''
      }, 5000)
    }
    else if (res.error) {
      recoverMsg.value = `Couldn’t claim yet: ${res.error}`
      setTimeout(() => {
        if (recoverMsg.value.startsWith('Couldn’t claim'))
          recoverMsg.value = ''
      }, 6500)
    }
    else {
      recoverMsg.value = ''
    }
  }
})
</script>

<template>
  <section class="wallet">
    <header v-if="!viewingPass" class="wallet__head">
      <div>
        <p class="wallet__eyebrow">
          Tickets
        </p>
        <h1 class="wallet__title">
          {{ showContacts ? 'Contacts' : inboxTab === 'sent' ? 'Sent' : inboxTab === 'received' ? 'Received' : 'Ready' }}
        </h1>
      </div>
    </header>

    <div
      v-if="!viewingPass"
      class="gp-filters"
      role="tablist"
      aria-label="Ticket inbox"
    >
      <button type="button" role="tab" :class="{ active: !showContacts && inboxTab === 'ready' }" @click="setInboxTab('ready')">
        Ready
      </button>
      <button type="button" role="tab" :class="{ active: !showContacts && inboxTab === 'sent' }" @click="setInboxTab('sent')">
        Sent
      </button>
      <button type="button" role="tab" :class="{ active: !showContacts && inboxTab === 'received' }" @click="setInboxTab('received')">
        Received
      </button>
      <button type="button" role="tab" :class="{ active: showContacts }" @click="showContacts = !showContacts">
        Contacts
      </button>
    </div>

    <p v-if="recoverMsg" class="gp-banner">
      {{ recoverMsg }}
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

    <template v-if="showContacts">
      <p class="wallet__lead">
        Saved locally on this device — never sent to the server.
      </p>
      <label class="gp-label" for="contact-name">Name</label>
      <input id="contact-name" v-model="contactName" class="gp-input" placeholder="Alex">
      <label class="gp-label" for="contact-addr">Nimiq address</label>
      <input id="contact-addr" v-model="contactAddress" class="gp-input" placeholder="NQ…">
      <button class="gp-btn sm" type="button" style="margin: 10px 0 16px;" @click="saveContact">
        {{ contactEditId ? 'Update contact' : 'Save contact' }}
      </button>
      <ul v-if="contacts.length" class="contact-list">
        <li v-for="c in contacts" :key="c.id" class="contact-row">
          <div>
            <strong>{{ c.name }}</strong>
            <p>{{ shortAddr(c.address) }}</p>
          </div>
          <div class="contact-row__actions">
            <button class="gp-btn ghost sm" type="button" @click="editContact(c)">
              Edit
            </button>
            <button class="gp-btn ghost sm" type="button" @click="deleteContact(c.id)">
              Delete
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="wallet__none">
        No contacts yet.
      </p>
    </template>

    <template v-else-if="inboxTab === 'sent'">
      <p class="wallet__lead">
        Passes you forwarded. Friends open Received after Connect.
      </p>
      <ul v-if="sentItems.length" class="sent-list">
        <li v-for="row in sentItems" :key="row.transfer.toTicketId" class="sent-card">
          <p class="sent-card__when">
            {{ formatEventWhen(row.transfer.createdAt) }}
          </p>
          <h2>{{ row.transfer.eventTitle }}</h2>
          <p>
            {{ row.transfer.tierName || 'Ticket' }}
            <template v-if="row.transfer.seatLabel">
              · {{ row.transfer.seatLabel }}
            </template>
          </p>
          <p class="sent-card__to">
            To {{ row.contactName || shortAddr(row.transfer.toAddress) }}
          </p>
        </li>
      </ul>
      <p v-else class="wallet__none">
        Nothing sent yet.
      </p>
    </template>

    <template v-else-if="!selectedEventId">
      <p class="wallet__lead">
        {{ inboxTab === 'received' ? 'Passes sent to this wallet.' : 'Select an event to open its pass.' }}
      </p>

      <div v-if="isDemoAllowed() && skipVerify" class="demo-pull">
        <label class="gp-label" for="demo-receive">Local demo — pull inbox as</label>
        <select
          v-if="contacts.length"
          id="demo-receive"
          v-model="demoReceiveAs"
          class="gp-input"
        >
          <option value="">
            Pick a contact
          </option>
          <option v-for="c in contacts" :key="c.id" :value="c.address">
            {{ c.name }}
          </option>
        </select>
        <input
          v-else
          id="demo-receive"
          v-model="demoReceiveAs"
          class="gp-input"
          placeholder="Friend NQ address"
        >
        <button class="gp-btn secondary sm" type="button" :disabled="loading" @click="pullDemoInbox">
          {{ loading ? 'Pulling…' : 'Pull received' }}
        </button>
      </div>

      <div v-if="!liveItems.length" class="wallet__empty">
        <div class="hex" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="48" height="48">
            <path fill="#E9B213" d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13L16 2.5Z" />
          </svg>
        </div>
        <h2>{{ inboxTab === 'received' ? 'Inbox empty' : 'Nothing here yet' }}</h2>
        <p>
          {{ inboxTab === 'received'
            ? 'Connect (or pull as a contact in demo) to load passes sent to you.'
            : 'Buy from Discover — your pass opens here right after payment.' }}
        </p>
        <button
          v-if="inboxTab === 'ready'"
          class="gp-btn sm"
          type="button"
          style="margin-top: 8px; max-width: 220px;"
          @click="emit('browse')"
        >
          Browse events
        </button>
      </div>

      <ul v-else class="event-list">
        <li v-for="g in eventGroups" :key="g.eventId">
          <button type="button" class="event-card" @click="openEvent(g.eventId)">
            <div
              class="event-card__media"
              :class="{ placeholder: !g.event.coverUrl }"
              :style="g.event.coverUrl ? { backgroundImage: `url(${g.event.coverUrl})` } : undefined"
            />
            <div class="event-card__body">
              <div class="event-card__row">
                <h2>{{ g.event.title }}</h2>
                <span v-if="g.readyCount" class="pill ready">{{ g.readyCount }} ready</span>
                <span v-else-if="g.redeemedCount" class="pill used">Checked in</span>
                <span v-else class="pill void">No active</span>
              </div>
              <p class="event-card__venue">
                {{ g.event.venueName }}
              </p>
              <p class="event-card__when">
                {{ formatEventWhen(g.event.startsAt) }}
              </p>
              <p class="event-card__meta">
                {{ g.tickets.length }} ticket{{ g.tickets.length === 1 ? '' : 's' }}
                <template v-if="g.redeemedCount">
                  · {{ g.redeemedCount }} in
                </template>
                <template v-if="g.cancelledCount">
                  · {{ g.cancelledCount }} void
                </template>
              </p>
            </div>
            <span class="event-card__chev" aria-hidden="true">›</span>
          </button>
        </li>
      </ul>
    </template>

    <!-- Step 2: pass for selected event -->
    <template v-else>
      <div class="pass-bar">
        <button class="wallet__back" type="button" @click="backToEvents">
          ← Events
        </button>
        <p v-if="needsPassFilter && readyInEvent" class="pass-bar__count">
          {{ readyInEvent }} ready
        </p>
      </div>

      <div
        v-if="needsPassFilter"
        class="gp-filters"
        role="tablist"
        aria-label="Passes for this event"
      >
        <button type="button" role="tab" :class="{ active: filter === 'ready' }" @click="setFilter('ready')">
          Ready
        </button>
        <button type="button" role="tab" :class="{ active: filter === 'all' }" @click="setFilter('all')">
          All ({{ showVoided ? eventTickets.length : eventTickets.length - voidedInEvent }})
        </button>
      </div>
      <label v-if="needsPassFilter && filter === 'all' && voidedInEvent" class="gp-check">
        <input v-model="showVoided" type="checkbox">
        Show voided ({{ voidedInEvent }})
      </label>

      <p v-if="!filtered.length" class="wallet__none">
        No ready tickets for this event — switch to All.
      </p>

      <template v-else-if="active">
        <div v-if="filtered.length > 1" class="wallet__nav">
          <button type="button" class="nav-btn" :disabled="!canPrev" aria-label="Previous ticket" @click="prev">
            ‹
          </button>
          <div class="wallet__dots" aria-hidden="true">
            <span
              v-for="(it, i) in filtered"
              :key="it.ticket.id"
              :class="{ on: i === activeIndex }"
            />
          </div>
          <span class="wallet__index">{{ activeIndex + 1 }} / {{ filtered.length }}</span>
          <button type="button" class="nav-btn" :disabled="!canNext" aria-label="Next ticket" @click="next">
            ›
          </button>
        </div>

        <div v-if="showBadge" class="wallet__badge">
          <AttendanceBadge :event="active.event" :ticket="active.ticket" :preview="previewBadge" />
          <button class="gp-btn ghost" type="button" @click="previewBadge = false">
            Back to pass
          </button>
        </div>

        <article
          v-else
          :key="animKey"
          class="pass"
          :class="active.ticket.status"
        >
          <div
            v-if="active.event.coverUrl"
            class="pass__cover"
            :style="{ backgroundImage: `url(${active.event.coverUrl})` }"
          />
          <div class="pass__top">
            <div class="pass__brand">
              <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
                <path fill="#E9B213" d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13L16 2.5Z" />
              </svg>
              <span>GatePass</span>
            </div>
            <span class="pass__status">{{ active.ticket.status }}</span>
          </div>

          <div class="pass__event">
            <div class="pass__date">
              <strong>{{ dateParts.day }}</strong>
              <span>{{ dateParts.month }}</span>
              <em>{{ dateParts.time }}</em>
            </div>
            <div class="pass__copy">
              <h2>{{ active.event.title }}</h2>
              <p>{{ active.event.venueName }}</p>
              <p v-if="active.ticket.tierName || active.ticket.seatLabel" class="pass__when">
                {{ [active.ticket.tierName, active.ticket.seatLabel].filter(Boolean).join(' · ') }}
              </p>
              <p class="pass__when">
                {{ whenLabel }}
              </p>
            </div>
          </div>

          <div class="pass__perforation" aria-hidden="true">
            <span v-for="n in 14" :key="n" />
          </div>

          <div v-if="active.ticket.status === 'valid'" class="pass__body">
            <p class="pass__scan">
              Scan at the gate
            </p>
            <RotatingTicketQr
              variant="pass"
              :event-id="active.ticket.eventId"
              :ticket-id="active.ticket.id"
              :ticket-seed="active.ticket.ticketSeed"
            />
            <button
              v-if="inboxTab === 'ready'"
              class="gp-btn sm"
              type="button"
              style="margin-top: 12px; max-width: 220px;"
              @click="openSend"
            >
              Send
            </button>
          </div>

          <div v-else-if="active.ticket.status === 'redeemed'" class="pass__body used">
            <div class="stamp">
              Checked in
            </div>
            <p>Your proof-of-attendance badge unlocks 24h after the event ends.</p>
            <button class="gp-btn sm" type="button" @click="previewBadge = true">
              Open badge
            </button>
          </div>

          <div v-else class="pass__body used">
            <div class="stamp void">
              Void
            </div>
            <p>This pass was cancelled or transferred.</p>
            <button
              v-if="readyInEvent"
              class="gp-btn sm"
              type="button"
              @click="setFilter('ready')"
            >
              Show ready passes
            </button>
          </div>

          <div class="pass__stub">
            <span class="pass__id">{{ active.ticket.id.slice(0, 10) }}</span>
            <button type="button" class="pass__more" @click="showTools = !showTools">
              {{ showTools ? 'Less' : 'More' }}
            </button>
          </div>
        </article>

        <div v-if="showTools && !showBadge" class="wallet__tools">
          <button
            v-if="active.ticket.status === 'valid' && inboxTab === 'ready'"
            class="gp-btn sm"
            type="button"
            @click="openSend"
          >
            Send to a friend
          </button>
          <button class="gp-btn ghost sm" type="button" @click="refreshActive">
            Refresh status
          </button>
          <button
            v-if="active.ticket.status === 'valid' || active.ticket.status === 'redeemed'"
            class="gp-btn ghost sm"
            type="button"
            @click="previewBadge = true"
          >
            Badge preview
          </button>
        </div>

        <FlashBanner
          v-if="status && selectedEventId"
          kind="success"
          :message="status"
          @clear="status = ''"
        />
        <FlashBanner
          v-if="error && selectedEventId"
          :message="error"
          @clear="error = ''"
        />
      </template>
    </template>

    <div v-if="sendOpen" class="send-sheet" @click.self="sendOpen = false">
      <div v-if="active" class="send-dialog__card">
        <h2 class="gp-h2">
          Send pass
        </h2>
        <p class="result-meta">
          {{ active.event.title }}
          <template v-if="active.ticket.tierName">
            · {{ active.ticket.tierName }}
          </template>
          <template v-if="active.ticket.seatLabel">
            · {{ active.ticket.seatLabel }}
          </template>
        </p>
        <label v-if="contacts.length" class="gp-label" for="send-contact">Contact</label>
        <select
          v-if="contacts.length"
          id="send-contact"
          class="gp-input"
          :value="sendContactId"
          @change="onSendContactChange($event)"
        >
          <option value="">
            Paste an address instead
          </option>
          <option v-for="c in contacts" :key="c.id" :value="c.id">
            {{ c.name }}
          </option>
        </select>
        <label class="gp-label" for="send-to">Nimiq address</label>
        <input id="send-to" v-model="sendTo" class="gp-input" placeholder="NQ…">
        <div class="send-dialog__actions">
          <button class="gp-btn ghost sm" type="button" @click="sendOpen = false">
            Cancel
          </button>
          <button class="gp-btn sm" type="button" :disabled="loading" @click="confirmSend">
            {{ loading ? 'Sending…' : 'Send' }}
          </button>
        </div>
      </div>
    </div>

    <ResultDialog
      :open="resultOpen"
      :kind="resultKind"
      :title="resultTitle"
      :message="resultMessage"
      :event-title="resultEvent"
      :tier="resultTier"
      @close="resultOpen = false"
    />
  </section>
</template>

<style scoped>
.wallet__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 8px;
}
.wallet__eyebrow {
  margin: 0 0 2px;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--gp-muted);
}
.wallet__title {
  margin: 0;
  font-size: 1.75rem;
  letter-spacing: 0;
  font-weight: 400;
  line-height: 1.2;
}
.wallet__lead {
  margin: 0 0 16px;
  color: var(--gp-muted);
  font-size: 0.94rem;
}
.wallet__count {
  text-align: right;
  line-height: 1.1;
  flex-shrink: 0;
}
.wallet__count strong {
  display: block;
  font-size: 1.5rem;
  letter-spacing: -0.03em;
}
.wallet__count span {
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--gp-muted);
}

.wallet__back {
  border: 0;
  background: transparent;
  padding: 0;
  min-height: var(--gp-tap);
  font-weight: 500;
  font-size: 0.875rem;
  color: var(--gp-navy);
}

.pass-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -4px 0 8px;
}
.pass-bar__count {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--gp-muted);
}

.wallet__empty {
  text-align: center;
  padding: 48px 20px 36px;
  border-radius: 16px;
  background: linear-gradient(165deg, #252a55 0%, #1f2348 55%, #151833 100%);
  color: #fff;
  box-shadow: none;
}
.wallet__empty h2 {
  margin: 12px 0 8px;
  font-size: 1.25rem;
}
.wallet__empty p {
  margin: 0;
  opacity: 0.78;
  font-size: 0.92rem;
  line-height: 1.45;
}
.hex {
  display: flex;
  justify-content: center;
  animation: float 3.2s ease-in-out infinite;
}

.event-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.event-card {
  position: relative;
  overflow: hidden;
  width: 100%;
  display: grid;
  grid-template-columns: 76px 1fr 20px;
  gap: 12px;
  align-items: stretch;
  text-align: left;
  border: 0;
  background: var(--gp-surface);
  border-radius: 16px;
  padding: 10px;
  min-height: var(--gp-tap);
  color: var(--gp-navy);
  box-shadow: none;
  transition: background 140ms var(--gp-ease);
}
.event-card::after {
  content: '';
  position: absolute;
  inset: 0;
  background: currentColor;
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms var(--gp-ease);
}
.event-card:active::after {
  opacity: 0.08;
}
.event-card:active {
  background: var(--gp-surface-soft);
}
.event-card__media {
  width: 76px;
  min-height: 76px;
  border-radius: 12px;
  background-size: cover;
  background-position: center;
  background-color: #dde1ef;
}
.event-card__media.placeholder {
  background: linear-gradient(145deg, #252a55 0%, #1f2348 100%);
}
.event-card__body {
  min-width: 0;
  padding: 2px 0;
}
.event-card__row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 4px;
}
.event-card__row h2 {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 1.05rem;
  letter-spacing: 0;
  font-weight: 500;
  line-height: 1.2;
}
.pill {
  flex-shrink: 0;
  font-size: 0.65rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  padding: 4px 8px;
  border-radius: 8px;
}
.pill.ready {
  background: rgba(33, 188, 165, 0.16);
  color: #0f7a6b;
}
.pill.used {
  background: rgba(233, 178, 19, 0.2);
  color: var(--gp-navy);
}
.pill.void {
  background: rgba(31, 35, 72, 0.08);
  color: var(--gp-muted);
}
.event-card__venue,
.event-card__when,
.event-card__meta {
  margin: 0;
  font-size: 0.82rem;
  color: var(--gp-muted);
  font-weight: 600;
}
.event-card__when {
  margin-top: 2px;
  font-weight: 500;
}
.event-card__meta {
  margin-top: 6px;
  font-size: 0.75rem;
  font-weight: 500;
}
.event-card__chev {
  align-self: center;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--gp-muted);
}

.wallet__filters {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  padding: 4px;
  border-radius: 20px;
  background: var(--gp-surface-high);
  margin-bottom: 12px;
}
.wallet__filters button {
  position: relative;
  overflow: hidden;
  border: 0;
  background: transparent;
  border-radius: 16px;
  min-height: 40px;
  padding: 10px;
  font-weight: 500;
  font-size: 0.875rem;
  color: var(--gp-muted);
}
.wallet__filters button.on {
  background: var(--gp-surface);
  color: var(--gp-navy);
  box-shadow: none;
}

.wallet__none {
  margin: 8px 0;
  color: var(--gp-muted);
  font-size: 0.92rem;
}

.wallet__nav {
  display: grid;
  grid-template-columns: 44px 1fr auto 44px;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.nav-btn {
  width: var(--gp-tap);
  height: var(--gp-tap);
  border-radius: 16px;
  border: 1px solid var(--gp-border);
  background: #fff;
  font-size: 1.5rem;
  font-weight: 500;
  color: var(--gp-navy);
  line-height: 1;
}
.nav-btn:disabled {
  opacity: 0.35;
}
.wallet__dots {
  display: flex;
  justify-content: center;
  gap: 5px;
}
.wallet__dots span {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: rgba(31, 35, 72, 0.18);
  transition: width 180ms var(--gp-ease), background 180ms var(--gp-ease);
}
.wallet__dots span.on {
  width: 18px;
  background: var(--gp-gold);
}
.wallet__index {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--gp-muted);
  letter-spacing: 0.04em;
}

.pass {
  position: relative;
  border-radius: 26px;
  overflow: hidden;
  color: #fff;
  background: linear-gradient(165deg, #252a55 0%, #1f2348 52%, #151833 100%);
  box-shadow:
    0 22px 48px rgba(31, 35, 72, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  animation: rise 320ms var(--gp-ease);
}
.pass.cancelled {
  filter: saturate(0.55);
}
.pass__cover {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  opacity: 0.18;
  pointer-events: none;
}

.pass__top,
.pass__event,
.pass__body,
.pass__stub {
  position: relative;
  z-index: 1;
}

.pass__top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 18px 8px;
}
.pass__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.pass__status {
  font-size: 0.68rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(233, 178, 19, 0.22);
  color: #f5d56a;
}
.pass.redeemed .pass__status {
  background: rgba(33, 188, 165, 0.22);
  color: #7eebda;
}
.pass.cancelled .pass__status {
  background: rgba(217, 68, 79, 0.22);
  color: #ff9aa2;
}

.pass__event {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 14px;
  padding: 8px 18px 16px;
  align-items: start;
}
.pass__date {
  text-align: center;
  padding: 10px 6px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.pass__date strong {
  display: block;
  font-size: 1.55rem;
  letter-spacing: -0.04em;
  line-height: 1;
}
.pass__date span {
  display: block;
  margin-top: 2px;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #e9b213;
}
.pass__date em {
  display: block;
  margin-top: 6px;
  font-style: normal;
  font-size: 0.72rem;
  font-weight: 700;
  opacity: 0.75;
}
.pass__copy h2 {
  margin: 0 0 4px;
  font-size: 1.28rem;
  letter-spacing: -0.03em;
  line-height: 1.15;
}
.pass__copy p {
  margin: 0;
  opacity: 0.78;
  font-size: 0.92rem;
  font-weight: 600;
}
.pass__when {
  margin-top: 6px !important;
  font-size: 0.8rem !important;
  font-weight: 500 !important;
  opacity: 0.6 !important;
}

.pass__perforation {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: space-between;
  padding: 0 10px;
}
.pass__perforation::before {
  content: '';
  position: absolute;
  left: 18px;
  right: 18px;
  top: 50%;
  border-top: 2px dashed rgba(255, 255, 255, 0.22);
}
.pass__perforation span {
  position: relative;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #eef0f7;
}

.pass__body {
  padding: 18px 16px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pass__scan {
  margin: 0 0 12px;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
}
.pass__body.used {
  text-align: center;
  padding: 28px 22px 20px;
  gap: 12px;
}
.pass__body.used p {
  margin: 0;
  opacity: 0.75;
  font-size: 0.92rem;
  line-height: 1.4;
  max-width: 260px;
}
.stamp {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 18px;
  border: 3px solid #21bca5;
  color: #7eebda;
  font-weight: 900;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  border-radius: 8px;
  transform: rotate(-6deg);
  font-size: 1.05rem;
}
.stamp.void {
  border-color: #ff8b93;
  color: #ff8b93;
}

.pass__stub {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 18px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.pass__id {
  font-family: var(--gp-mono);
  font-size: 0.72rem;
  opacity: 0.55;
  letter-spacing: 0.04em;
}
.pass__more {
  border: 0;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  border-radius: 999px;
  padding: 7px 14px;
  font-weight: 800;
  font-size: 0.78rem;
}

.wallet__tools {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: rise 240ms var(--gp-ease);
}
.transfer {
  display: flex;
  flex-direction: column;
}
.wallet__badge {
  animation: rise 280ms var(--gp-ease);
}
.wallet__badge .gp-btn {
  margin-top: 12px;
}

@keyframes rise {
  from { opacity: 0; transform: translateY(10px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

@media (prefers-reduced-motion: reduce) {
  .pass,
  .wallet__badge,
  .wallet__tools,
  .hex {
    animation: none !important;
  }
}

.contact-list,
.sent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.contact-row,
.sent-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--gp-surface);
}
.contact-row p,
.sent-card p {
  margin: 4px 0 0;
  color: var(--gp-muted);
  font-size: 0.82rem;
}
.contact-row strong,
.sent-card h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 500;
}
.contact-row__actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.sent-card {
  display: block;
}
.sent-card__when,
.sent-card__to {
  font-size: 0.78rem !important;
}
.demo-pull {
  margin: 0 0 16px;
  padding: 12px;
  border-radius: 16px;
  background: var(--gp-surface-soft);
}
.send-sheet {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: end center;
  padding: 16px 16px 88px;
  background: rgba(31, 35, 72, 0.4);
}
.send-dialog__card {
  width: min(420px, 100%);
  border-radius: 16px;
  padding: 20px 16px 16px;
  background: var(--gp-surface);
  box-shadow: 0 8px 32px rgba(31, 35, 72, 0.24);
}
.result-meta {
  margin: 0 0 12px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--gp-navy);
}
.send-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
</style>
