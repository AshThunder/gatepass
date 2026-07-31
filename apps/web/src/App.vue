<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import AppHeader from '@/components/AppHeader.vue'
import BouncerView from '@/views/BouncerView.vue'
import DiscoverView from '@/views/DiscoverView.vue'
import EventDetailView from '@/views/EventDetailView.vue'
import MyTicketsView from '@/views/MyTicketsView.vue'
import OrganizerView from '@/views/OrganizerView.vue'
import PrivacyView from '@/views/PrivacyView.vue'
import { claimPendingTx, readPendingTx } from '@/lib/claimPending'
import { flushDueReminders } from '@/lib/reminders'
import { useWallet } from '@/nimiq/useWallet'
import type { EventRecord, TicketRecord } from '@gatepass/shared'

type Tab = 'discover' | 'tickets' | 'host' | 'gate'

const tab = ref<Tab>('discover')
const selectedEventId = ref<string | null>(null)
const ticketsKey = ref(0)
const claimBanner = ref('')
const pendingBanner = ref('')
const showPrivacy = ref(false)

const { ready: walletReady, busy: walletBusy, label: walletLabel, connect: connectWallet, probe: probeWallet } = useWallet()

onMounted(async () => {
  flushDueReminders()
  void probeWallet()
  const params = new URLSearchParams(window.location.search)
  if (params.get('tab') === 'privacy' || params.get('view') === 'privacy')
    showPrivacy.value = true
  const t = params.get('tab') || params.get('role')
  if (t === 'discover' || t === 'tickets' || t === 'host' || t === 'gate')
    tab.value = t
  else if (t === 'organizer')
    tab.value = 'host'
  const eventId = params.get('event')
  if (eventId) {
    selectedEventId.value = eventId
    tab.value = 'discover'
  }

  if (readPendingTx()) {
    pendingBanner.value = 'Recovering a previous payment…'
    const res = await claimPendingTx()
    if (res.ok && res.event) {
      claimBanner.value = res.tickets && res.tickets.length > 1
        ? `${res.tickets.length} tickets recovered for ${res.event.title}`
        : `Ticket recovered for ${res.event.title}`
      ticketsKey.value += 1
      tab.value = 'tickets'
      setTimeout(() => {
        claimBanner.value = ''
      }, 8000)
    }
    else if (res.error) {
      pendingBanner.value = `Payment pending — open the event to claim. (${res.error})`
    }
    else {
      pendingBanner.value = ''
    }
    if (res.ok)
      pendingBanner.value = ''
  }
})

function setTab(next: Tab) {
  showPrivacy.value = false
  tab.value = next
  if (next !== 'discover')
    selectedEventId.value = null
  const url = new URL(window.location.href)
  url.searchParams.set('tab', next)
  url.searchParams.delete('view')
  if (next === 'discover' && selectedEventId.value)
    url.searchParams.set('event', selectedEventId.value)
  else
    url.searchParams.delete('event')
  history.replaceState(null, '', url)
}

function openPrivacy() {
  showPrivacy.value = true
  const url = new URL(window.location.href)
  url.searchParams.set('view', 'privacy')
  history.replaceState(null, '', url)
}

function closePrivacy() {
  showPrivacy.value = false
  const url = new URL(window.location.href)
  url.searchParams.delete('view')
  history.replaceState(null, '', url)
}

function openEvent(eventId: string) {
  showPrivacy.value = false
  selectedEventId.value = eventId
  tab.value = 'discover'
  const url = new URL(window.location.href)
  url.searchParams.set('tab', 'discover')
  url.searchParams.set('event', eventId)
  url.searchParams.delete('view')
  history.replaceState(null, '', url)
}

function backToDiscover() {
  selectedEventId.value = null
  const url = new URL(window.location.href)
  url.searchParams.delete('event')
  history.replaceState(null, '', url)
}

function onPurchased(tickets: TicketRecord[], event: EventRecord) {
  const n = tickets.length
  claimBanner.value = n > 1
    ? `${n} tickets for ${event.title} are ready`
    : `Ticket for ${event.title} is ready`
  localStorage.setItem('gatepass:pendingOpenEvent', event.id)
  ticketsKey.value += 1
  setTab('tickets')
  setTimeout(() => {
    claimBanner.value = ''
  }, 7000)
}

watch(tab, (t) => {
  if (t !== 'discover')
    selectedEventId.value = null
})
</script>

<template>
  <div class="gp-shell">
    <AppHeader>
      <template #right>
        <div class="header-actions">
          <button
            class="connect-btn"
            :class="{ on: walletReady }"
            type="button"
            :disabled="walletBusy"
            @click="connectWallet"
          >
            {{ walletBusy ? '…' : walletLabel }}
          </button>
          <button class="privacy-link" type="button" @click="openPrivacy">
            Privacy
          </button>
        </div>
      </template>
    </AppHeader>

    <div v-if="claimBanner" class="gp-toast" role="status">
      <span class="gp-pill ok">Ready</span>
      <p class="gp-sub" style="margin: 8px 0 0;">
        {{ claimBanner }}
      </p>
    </div>
    <div v-else-if="pendingBanner" class="gp-banner warn" role="status">
      {{ pendingBanner }}
    </div>

    <main class="gp-main">
      <PrivacyView v-if="showPrivacy" @close="closePrivacy" />
      <template v-else>
        <!-- Keep tabs mounted so Host/Gate/Tickets state survives navigation -->
        <section v-show="tab === 'discover' && !selectedEventId" class="gp-panel">
          <DiscoverView
            @open-event="openEvent"
            @go-host="setTab('host')"
          />
        </section>
        <section
          v-if="tab === 'discover' && selectedEventId"
          :key="selectedEventId"
          class="gp-panel"
        >
          <EventDetailView
            :event-id="selectedEventId"
            @back="backToDiscover"
            @purchased="onPurchased"
          />
        </section>
        <section v-show="tab === 'tickets'" class="gp-panel">
          <MyTicketsView :key="ticketsKey" @browse="setTab('discover')" />
        </section>
        <section v-show="tab === 'host'" class="gp-panel">
          <OrganizerView />
        </section>
        <!-- Gate remounts so the camera only runs while this tab is open -->
        <section v-if="tab === 'gate'" class="gp-panel">
          <BouncerView />
        </section>
      </template>
    </main>

    <nav v-if="!showPrivacy" class="gp-tabbar" aria-label="Main">
      <button :class="{ active: tab === 'discover' }" type="button" @click="setTab('discover')">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2" />
          <path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        Discover
      </button>
      <button :class="{ active: tab === 'tickets' }" type="button" @click="setTab('tickets')">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="6" width="18" height="12" rx="2.5" stroke="currentColor" stroke-width="2" />
          <path d="M8 6v12M16 10.5h.01M16 13.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        Tickets
      </button>
      <button :class="{ active: tab === 'host' }" type="button" @click="setTab('host')">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 4l7 3.5v5c0 4-3 7-7 8.5-4-1.5-7-4.5-7-8.5v-5L12 4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
        </svg>
        Host
      </button>
      <button :class="{ active: tab === 'gate' }" type="button" @click="setTab('gate')">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2" />
          <path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        Gate
      </button>
    </nav>
  </div>
</template>

<style scoped>
.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.connect-btn {
  border: 0;
  background: var(--gp-navy);
  color: #fff;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 0.74rem;
  font-weight: 800;
  min-width: 72px;
  transition: background 160ms var(--gp-ease), opacity 160ms var(--gp-ease);
}
.connect-btn.on {
  background: linear-gradient(135deg, var(--gp-gold), #f0c94a);
  color: var(--gp-navy);
}
.connect-btn:disabled {
  opacity: 0.55;
}
.privacy-link {
  border: 0;
  background: transparent;
  color: var(--gp-muted);
  font-size: 0.74rem;
  font-weight: 700;
  padding: 6px 4px;
}
.privacy-link:hover {
  color: var(--gp-navy);
}
</style>
