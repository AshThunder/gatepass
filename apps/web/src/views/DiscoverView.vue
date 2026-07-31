<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api/client'
import EventCard from '@/components/EventCard.vue'
import type { EventRecord } from '@gatepass/shared'

const emit = defineEmits<{
  openEvent: [eventId: string]
  goHost: []
}>()

type Filter = 'upcoming' | 'tonight' | 'weekend' | 'all'

const events = ref<EventRecord[]>([])
const loading = ref(true)
const error = ref('')
const query = ref('')
const filter = ref<Filter>('upcoming')
const showEnded = ref(false)

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

/** Soonest event gets the featured pass when there’s more than one. */
const featured = computed(() => {
  if (query.value.trim() || filtered.value.length < 2)
    return null
  if (filter.value !== 'upcoming' && filter.value !== 'tonight')
    return null
  return filtered.value[0] || null
})

const list = computed(() => {
  if (!featured.value)
    return filtered.value
  return filtered.value.slice(1)
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
  loading.value = true
  error.value = ''
  try {
    const res = await api.listEvents()
    events.value = res.events
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

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

    <div v-if="loading" class="discover__loading">
      <div class="skel featured" />
      <div class="skel" />
      <div class="skel" />
    </div>
    <p v-else-if="error" class="gp-error">
      {{ error }}
    </p>
    <div v-else-if="!filtered.length" class="gp-card">
      <div class="gp-empty">
        <svg class="gp-hex" viewBox="0 0 32 32" width="40" height="40" aria-hidden="true">
          <path fill="#E9B213" d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13L16 2.5Z" />
        </svg>
        <h2>No events here</h2>
        <p>Try another filter, or create one from Host.</p>
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
          <span>Up next</span>
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
.discover__eyebrow {
  margin: 0 0 6px;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #b8860b;
}
.discover__title {
  margin: 0 0 6px;
  font-size: 1.45rem;
  font-weight: 800;
  letter-spacing: -0.035em;
  line-height: 1.1;
  color: var(--gp-navy);
}
.discover__lead {
  margin: 0;
  max-width: 36ch;
  color: var(--gp-muted);
  font-size: 0.84rem;
  line-height: 1.4;
  font-weight: 600;
}

.discover__tools {
  margin: 18px 0 20px;
}

.discover__search {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 0 14px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--gp-border);
  color: var(--gp-muted);
  box-shadow: 0 6px 20px rgba(31, 35, 72, 0.05);
}
.discover__search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 13px 0;
  color: var(--gp-navy);
  font-weight: 600;
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
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
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
