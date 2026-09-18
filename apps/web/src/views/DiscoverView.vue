<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import * as catalog from '@/lib/catalog'
import EventCard from '@/components/EventCard.vue'
import HallMapPreview from '@/components/HallMapPreview.vue'
import FlashBanner from '@/components/FlashBanner.vue'

const emit = defineEmits<{
  openEvent: [eventId: string]
  goHost: [hall?: boolean]
}>()

const props = defineProps<{
  active?: boolean
}>()

type Filter = 'upcoming' | 'tonight' | 'weekend' | 'all'

const events = catalog.events
const hall = catalog.hall
const loading = catalog.loading
const error = catalog.error
const showHallPreview = ref(false)
const query = ref('')
const filter = ref<Filter>('upcoming')
const showEnded = ref(false)

const openHallSlots = computed(() =>
  (hall.value?.slots || []).filter(s => s.status === 'open'),
)

const nextHallSlotLabel = computed(() => {
  const s = openHallSlots.value[0]
  if (!s)
    return ''
  return new Date(s.startsAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
})

function startOfDay(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d = new Date()) {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

function weekendRange(now = new Date()) {
  const day = now.getDay()
  const toSat = day === 6 ? 0 : (6 - day)
  const toSun = day === 0 ? 0 : (7 - day)
  const sat = startOfDay(new Date(now.getTime() + toSat * 86400000))
  if (day === 0)
    return { start: startOfDay(now), end: endOfDay(now) }
  if (day === 6)
    return { start: sat, end: endOfDay(new Date(sat.getTime() + 86400000)) }
  return { start: sat, end: endOfDay(new Date(now.getTime() + toSun * 86400000)) }
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const now = Date.now()
  let list = [...events.value]

  if (filter.value === 'upcoming')
    list = list.filter(e => new Date(e.endsAt).getTime() >= now)
  else if (filter.value === 'tonight') {
    const a = startOfDay().getTime()
    const b = endOfDay().getTime()
    list = list.filter((e) => {
      const s = new Date(e.startsAt).getTime()
      const end = new Date(e.endsAt).getTime()
      return end >= now && s <= b && end >= a
    })
  }
  else if (filter.value === 'weekend') {
    const { start, end } = weekendRange()
    list = list.filter((e) => {
      const s = new Date(e.startsAt).getTime()
      return s >= start.getTime() && s <= end.getTime()
    })
  }
  else if (filter.value === 'all' && !showEnded.value) {
    list = list.filter(e => new Date(e.endsAt).getTime() >= now)
  }

  if (q) {
    list = list.filter(e =>
      e.title.toLowerCase().includes(q)
      || e.venueName.toLowerCase().includes(q)
      || (e.description || '').toLowerCase().includes(q),
    )
  }

  return list.sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt))
})

/** Prefer Nimiq Hall events, else soonest upcoming. */
const featured = computed(() => {
  if (query.value.trim() || filtered.value.length < 2)
    return null
  if (filter.value !== 'upcoming' && filter.value !== 'tonight')
    return null
  const hall = filtered.value.find(e => e.hallSlotId)
  return hall || filtered.value[0] || null
})

const list = computed(() => {
  if (!featured.value)
    return filtered.value
  return filtered.value.filter(e => e.id !== featured.value!.id)
})

const resultLabel = computed(() => {
  const n = filtered.value.length
  if (loading.value)
    return ''
  if (n === 0)
    return 'None'
  return `${n}`
})

async function load() {
  await catalog.refreshCatalog()
}

watch(() => props.active, (on) => {
  if (on)
    void catalog.refreshCatalog()
})

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="discover">
    <header class="discover__intro">
      <p class="discover__eyebrow">
        Discover
      </p>
      <h1 class="discover__title">
        Events
      </h1>
      <p class="discover__lead">
        Browse what’s on, pay with NIM, and show your pass at the door.
      </p>
    </header>

    <div class="discover__tools">
      <label class="discover__search">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <input
          v-model="query"
          type="search"
          placeholder="Search events or venues"
          aria-label="Search events"
        >
      </label>

      <div class="gp-filters" role="tablist" aria-label="Time filters">
        <button
          v-for="f in ([
            ['upcoming', 'Upcoming'],
            ['tonight', 'Today'],
            ['weekend', 'Weekend'],
            ['all', 'All'],
          ] as const)"
          :key="f[0]"
          type="button"
          role="tab"
          :class="{ active: filter === f[0] }"
          @click="filter = f[0]"
        >
          {{ f[1] }}
        </button>
      </div>
      <label v-if="filter === 'all'" class="gp-check" style="margin: 2px 0 0;">
        <input v-model="showEnded" type="checkbox">
        Show ended
      </label>
    </div>

    <details
      v-if="!loading && hall && openHallSlots.length"
      class="gp-details hall-promo"
    >
      <summary>
        <span class="hall-promo__line">
          <span class="gp-pill gold">Nimiq Hall</span>
          <span class="hall-promo__next">{{ nextHallSlotLabel }}</span>
        </span>
      </summary>
      <div class="hall-promo__body">
        <p class="gp-sub">
          {{ hall.capacity }} labeled seats. Rent from Host ({{ hall.rentNim }} NIM), then sell up to {{ hall.capacity }} tickets.
        </p>
        <div class="gp-row" style="margin-top: 10px;">
          <button class="gp-btn secondary" type="button" @click="emit('goHost', true)">
            Book Nimiq Hall
          </button>
          <button
            class="gp-btn ghost sm"
            type="button"
            @click="showHallPreview = !showHallPreview"
          >
            {{ showHallPreview ? 'Hide preview' : 'Hall preview' }}
          </button>
        </div>
        <HallMapPreview
          v-if="showHallPreview && hall.previewSeats?.length"
          :seats="hall.previewSeats"
        />
      </div>
    </details>

    <FlashBanner
      v-if="error"
      :message="error"
      @clear="error = ''"
    />

    <div v-if="loading" class="discover__loading">
      <div class="skel featured" />
      <div class="skel" />
      <div class="skel" />
    </div>
    <div v-else-if="!filtered.length" class="gp-card">
      <div class="gp-empty">
        <svg class="gp-hex" viewBox="0 0 32 32" width="40" height="40" aria-hidden="true">
          <path fill="#E9B213" d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13L16 2.5Z" />
        </svg>
        <h2>No events here</h2>
        <p>Try another filter, or book Nimiq Hall from Host.</p>
        <div class="gp-row" style="max-width: 280px; margin: 0 auto;">
          <button class="gp-btn ghost sm" type="button" @click="load">
            Refresh
          </button>
          <button class="gp-btn secondary sm" type="button" @click="emit('goHost')">
            Host
          </button>
        </div>
      </div>
    </div>

    <template v-else>
      <div v-if="featured" class="discover__feature">
        <div class="discover__label">
          <span>{{ featured.hallSlotId ? 'Nimiq Hall' : 'Up next' }}</span>
        </div>
        <EventCard
          class="discover__item"
          :event="featured"
          featured
          @select="emit('openEvent', featured.id)"
        />
      </div>

      <div v-if="list.length" class="discover__rest">
        <div class="discover__label">
          <span>{{ featured ? 'More events' : 'Events' }}</span>
          <span v-if="resultLabel" class="discover__count">{{ resultLabel }}</span>
        </div>
        <div class="discover__list">
          <EventCard
            v-for="(ev, i) in list"
            :key="ev.id"
            class="discover__item"
            :style="{ animationDelay: `${Math.min(i, 8) * 40}ms` }"
            :event="ev"
            @select="emit('openEvent', ev.id)"
          />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.discover__intro {
  margin-bottom: 4px;
}
.hall-promo {
  margin: 0 0 12px;
}
.hall-promo__line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.hall-promo__next {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--gp-muted);
}
.hall-promo__body {
  padding: 0 2px 4px;
}
.hall-promo__body .gp-btn {
  margin-top: 0;
}
.discover__eyebrow {
  margin: 0 0 4px;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--gp-muted);
}
.discover__title {
  margin: 0 0 6px;
  font-size: 1.75rem;
  font-weight: 400;
  letter-spacing: 0;
  line-height: 1.2;
  color: var(--gp-navy);
}
.discover__lead {
  margin: 0;
  max-width: 40ch;
  color: var(--gp-muted);
  font-size: 0.875rem;
  line-height: 1.4;
  font-weight: 400;
}

.discover__tools {
  margin: 16px 0 16px;
}

.discover__search {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 0 16px;
  min-height: 56px;
  border-radius: 28px;
  background: var(--gp-surface-high);
  border: 0;
  color: var(--gp-muted);
}
.discover__search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 16px 0;
  color: var(--gp-navy);
  font-weight: 400;
}
.discover__search input::placeholder {
  color: var(--gp-muted);
}
.discover__search input:focus {
  outline: none;
}

.discover__label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--gp-muted);
}
.discover__count {
  letter-spacing: 0;
  text-transform: none;
  color: #b8860b;
}

.discover__feature {
  margin-bottom: 22px;
}
.discover__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.discover__item {
  animation: rise 400ms var(--gp-ease) both;
}

.discover__loading {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.skel {
  height: 92px;
  border-radius: 16px;
  background: linear-gradient(
    90deg,
    rgba(31, 35, 72, 0.06) 0%,
    rgba(31, 35, 72, 0.11) 45%,
    rgba(31, 35, 72, 0.06) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.2s ease-in-out infinite;
}
.skel.featured {
  height: 104px;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .discover__item,
  .skel {
    animation: none !important;
  }
}
</style>
