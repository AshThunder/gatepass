<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import AttendanceBadge from '@/components/AttendanceBadge.vue'
import RotatingTicketQr from '@/components/RotatingTicketQr.vue'
import { claimPendingTx, readPendingTx } from '@/lib/claimPending'
import {
  type EventRecord,
  type TicketRecord,
  isBadgePhase,
} from '@gatepass/shared'

interface Stored {
  ticket: TicketRecord
  event: EventRecord
}

interface EventGroup {
  eventId: string
  event: EventRecord
  tickets: Stored[]
  readyCount: number
  redeemedCount: number
  cancelledCount: number
}

type Filter = 'ready' | 'all'

const emit = defineEmits<{ browse: [] }>()

const items = ref<Stored[]>([])
const selectedEventId = ref<string | null>(null)
const activeId = ref('')
const error = ref('')
const status = ref('')
const transferTo = ref('')
const previewBadge = ref(false)
const loading = ref(false)
const filter = ref<Filter>('ready')
const showVoided = ref(false)
const showTools = ref(false)
const animKey = ref(0)
const recoverMsg = ref('')

const eventGroups = computed((): EventGroup[] => {
  const map = new Map<string, EventGroup>()
  for (const item of items.value) {
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

function formatEventWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
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

  selectedEventId.value = null
  // After a purchase, jump straight into that event’s pass
  const pending = localStorage.getItem('gatepass:pendingOpenEvent')
  if (pending && eventGroups.value.some(g => g.eventId === pending)) {
    localStorage.removeItem('gatepass:pendingOpenEvent')
    openEvent(pending)
    return
  }
  // One event → open the pass immediately
  if (eventGroups.value.length === 1)
    openEvent(eventGroups.value[0]!.eventId)
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
  if (eventGroups.value.length <= 1) {
    emit('browse')
    return
  }
  selectedEventId.value = null
  previewBadge.value = false
  showTools.value = false
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
  try {
    const res = await api.getTicket(active.value.ticket.id)
    const idx = items.value.findIndex(i => i.ticket.id === res.ticket.id)
    if (idx >= 0)
      items.value[idx]!.ticket = res.ticket
    persist()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function transfer() {
  if (!active.value)
    return
  error.value = ''
  status.value = ''
  const to = transferTo.value.trim()
  if (!to) {
    error.value = 'Enter recipient NIM address'
    return
  }
  loading.value = true
  try {
    const res = await api.transferTicket(
      active.value.ticket.id,
      to,
      active.value.ticket.buyerAddress,
    )
    const idx = items.value.findIndex(i => i.ticket.id === res.cancelledTicketId)
    const event = active.value.event
    if (idx >= 0)
      items.value.splice(idx, 1)
    items.value.unshift({ ticket: res.ticket, event })
    activeId.value = res.ticket.id
    transferTo.value = ''
    showTools.value = false
    persist()
    status.value = 'Ticket transferred'
    void bumpAnim()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
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

onMounted(async () => {
  loadLocal()
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
    }
    else {
      recoverMsg.value = ''
    }
  }
})
</script>

<template>
  <section class="wallet">
    <!-- Step 1: pick event -->
    <template v-if="!selectedEventId">
      <header class="wallet__head">
        <div>
          <p class="wallet__eyebrow">
            Tickets
          </p>
          <h1 class="wallet__title">
            Choose event
          </h1>
        </div>
        <div v-if="items.length" class="wallet__count">
          <strong>{{ eventGroups.length }}</strong>
          <span>{{ eventGroups.length === 1 ? 'event' : 'events' }}</span>
        </div>
      </header>

      <p class="wallet__lead">
        Select an event to open its pass.
      </p>

      <div v-if="!items.length" class="wallet__empty">
        <div class="hex" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="48" height="48">
            <path fill="#E9B213" d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13L16 2.5Z" />
          </svg>
        </div>
        <h2>Nothing here yet</h2>
        <p>Buy from Discover — your pass opens here right after payment.</p>
        <button class="gp-btn secondary sm" type="button" style="margin-top: 8px; max-width: 220px;" @click="emit('browse')">
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
                <template v-if="g.redeemedCount"> · {{ g.redeemedCount }} in</template>
                <template v-if="g.cancelledCount"> · {{ g.cancelledCount }} void</template>
              </p>
            </div>
            <span class="event-card__chev" aria-hidden="true">›</span>
          </button>
        </li>
      </ul>
    </template>

    <!-- Step 2: pass for selected event -->
    <template v-else>
      <button class="wallet__back" type="button" @click="backToEvents">
        {{ eventGroups.length > 1 ? '← Events' : '← Discover' }}
      </button>

      <header class="wallet__head">
        <div>
          <p class="wallet__eyebrow">
            {{ selectedGroup?.event.venueName }}
          </p>
          <h1 class="wallet__title">
            {{ selectedGroup?.event.title }}
          </h1>
        </div>
        <div class="wallet__count">
          <strong>{{ readyInEvent }}</strong>
          <span>ready</span>
        </div>
      </header>

      <p v-if="recoverMsg" class="gp-banner">
        {{ recoverMsg }}
      </p>

      <div class="gp-filters" role="tablist" aria-label="Ticket filters">
        <button type="button" role="tab" :class="{ active: filter === 'ready' }" @click="setFilter('ready')">
          Ready
        </button>
        <button type="button" role="tab" :class="{ active: filter === 'all' }" @click="setFilter('all')">
          All ({{ showVoided ? eventTickets.length : eventTickets.length - voidedInEvent }})
        </button>
      </div>
      <label v-if="filter === 'all' && voidedInEvent" class="gp-check">
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
          <div v-if="active.ticket.status === 'valid'" class="transfer">
            <label class="gp-label">Transfer to</label>
            <input v-model="transferTo" class="gp-input" placeholder="NQ…">
            <button class="gp-btn secondary sm" type="button" :disabled="loading" @click="transfer">
              {{ loading ? 'Transferring…' : 'Transfer' }}
            </button>
          </div>
        </div>

        <p v-if="status" class="gp-success">
          {{ status }}
        </p>
        <p v-if="error" class="gp-error">
          {{ error }}
        </p>
      </template>
    </template>
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
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--gp-muted);
}
.wallet__title {
  margin: 0;
  font-size: 1.55rem;
  letter-spacing: -0.04em;
  font-weight: 800;
  line-height: 1.15;
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
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--gp-muted);
}

.wallet__back {
  border: 0;
  background: transparent;
  padding: 0 0 10px;
  font-weight: 800;
  font-size: 0.9rem;
  color: var(--gp-muted);
}

.wallet__empty {
  text-align: center;
  padding: 48px 20px 36px;
  border-radius: 24px;
  background: linear-gradient(165deg, #252a55 0%, #1f2348 55%, #151833 100%);
  color: #fff;
  box-shadow: 0 18px 40px rgba(31, 35, 72, 0.28);
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
  width: 100%;
  display: grid;
  grid-template-columns: 76px 1fr 20px;
  gap: 12px;
  align-items: stretch;
  text-align: left;
  border: 1px solid var(--gp-border);
  background: #fff;
  border-radius: 18px;
  padding: 10px;
  color: var(--gp-navy);
  box-shadow: var(--gp-shadow);
  transition: transform 140ms var(--gp-ease);
}
.event-card:active {
  transform: scale(0.985);
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
  letter-spacing: -0.02em;
  font-weight: 800;
  line-height: 1.2;
}
.pill {
  flex-shrink: 0;
  font-size: 0.65rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 4px 8px;
  border-radius: 999px;
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
  font-weight: 700;
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
  gap: 4px;
  padding: 4px;
  border-radius: 14px;
  background: rgba(31, 35, 72, 0.07);
  margin-bottom: 12px;
}
.wallet__filters button {
  border: 0;
  background: transparent;
  border-radius: 11px;
  padding: 10px;
  font-weight: 800;
  font-size: 0.88rem;
  color: var(--gp-muted);
}
.wallet__filters button.on {
  background: #fff;
  color: var(--gp-navy);
  box-shadow: 0 2px 10px rgba(31, 35, 72, 0.1);
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
  width: 44px;
  height: 44px;
  border-radius: 14px;
  border: 1px solid var(--gp-border);
  background: #fff;
  font-size: 1.5rem;
  font-weight: 700;
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
  font-weight: 800;
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
</style>
