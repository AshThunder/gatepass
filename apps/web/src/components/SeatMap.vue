<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import FlashBanner from '@/components/FlashBanner.vue'
import type { SeatRecord } from '@gatepass/shared'

const props = defineProps<{
  eventId: string
  tierId: string
  modelValue: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [ids: string[]]
}>()

const seats = ref<SeatRecord[]>([])
const error = ref('')
let poll: ReturnType<typeof setInterval> | null = null

const selected = computed({
  get: () => new Set(props.modelValue),
  set: (s: Set<string>) => emit('update:modelValue', [...s]),
})

const selectedLabels = computed(() =>
  props.modelValue
    .map(id => seats.value.find(s => s.id === id)?.label)
    .filter((x): x is string => !!x),
)

const rowKeys = computed(() => {
  const keys = [...new Set(seats.value.map(s => s.rowKey))]
  return keys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
})

function rowLabelPos(rowKey: string) {
  const row = seats.value.filter(s => s.rowKey === rowKey)
  if (!row.length)
    return { x: 2, y: 50 }
  const y = 8 + (row.reduce((s, r) => s + r.y, 0) / row.length) * 88
  return { x: 3.5, y }
}

async function load() {
  try {
    const res = await api.seats(props.eventId, props.tierId)
    seats.value = res.seats
    const next = props.modelValue.filter((id) => {
      const s = res.seats.find(x => x.id === id)
      return s && (s.status === 'available' || selected.value.has(id))
    })
    if (next.length !== props.modelValue.length)
      emit('update:modelValue', next)
    error.value = ''
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function toggle(seat: SeatRecord) {
  if (seat.status === 'sold')
    return
  if (seat.status === 'held' && !selected.value.has(seat.id))
    return
  const next = new Set(selected.value)
  if (next.has(seat.id))
    next.delete(seat.id)
  else
    next.add(seat.id)
  selected.value = next
}

function seatClass(s: SeatRecord) {
  if (selected.value.has(s.id))
    return 'sel'
  if (s.status === 'sold')
    return 'sold'
  if (s.status === 'held')
    return 'held'
  return 'free'
}

onMounted(() => {
  void load()
  poll = setInterval(() => void load(), 5000)
})
onUnmounted(() => {
  if (poll)
    clearInterval(poll)
})
watch(() => props.tierId, () => {
  emit('update:modelValue', [])
  void load()
})
</script>

<template>
  <div class="map">
    <div class="map__legend">
      <span><i class="free" /> Available</span>
      <span><i class="sel" /> Selected</span>
      <span><i class="held" /> Held</span>
      <span><i class="sold" /> Sold</span>
    </div>
    <FlashBanner
      v-if="error"
      :message="error"
      @clear="error = ''"
    />
    <svg class="map__svg" viewBox="0 0 100 100" role="img" aria-label="Seat map">
      <rect x="18" y="2" width="64" height="6" rx="1.5" fill="rgba(31,35,72,0.12)" />
      <text x="50" y="6.4" text-anchor="middle" font-size="3" fill="#6b7194" font-weight="700">
        STAGE
      </text>
      <text
        v-for="rk in rowKeys"
        :key="`lab-${rk}`"
        :x="rowLabelPos(rk).x"
        :y="rowLabelPos(rk).y + 1"
        text-anchor="middle"
        font-size="2.6"
        font-weight="800"
        fill="#6b7194"
      >
        {{ rk }}
      </text>
      <circle
        v-for="s in seats"
        :key="s.id"
        :cx="s.x * 100"
        :cy="8 + s.y * 88"
        r="2.35"
        class="dot"
        :class="seatClass(s)"
        @click="toggle(s)"
      >
        <title>{{ s.label }} · {{ s.status }}</title>
      </circle>
    </svg>
    <div v-if="selectedLabels.length" class="map__chips">
      <span v-for="lab in selectedLabels" :key="lab" class="map__chip">{{ lab }}</span>
    </div>
    <p v-else class="map__hint">
      Tap seats to select
    </p>
  </div>
</template>

<style scoped>
.map {
  margin-bottom: 12px;
}
.map__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--gp-muted);
}
.map__legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  margin-right: 4px;
  vertical-align: middle;
}
.map__legend i.free { background: #1f2348; }
.map__legend i.sel { background: #e9b213; }
.map__legend i.held { background: #9aa0b8; }
.map__legend i.sold { background: #d9444f; }

.map__svg {
  width: 100%;
  aspect-ratio: 1.15;
  background: var(--gp-surface-soft);
  border-radius: 14px;
  border: 1px solid var(--gp-border);
}
.dot {
  cursor: pointer;
}
.dot.free { fill: #1f2348; }
.dot.sel { fill: #e9b213; stroke: #1f2348; stroke-width: 0.4; }
.dot.held { fill: #9aa0b8; cursor: not-allowed; }
.dot.sold { fill: #d9444f; cursor: not-allowed; opacity: 0.75; }

.map__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.map__chip {
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(233, 178, 19, 0.18);
  color: var(--gp-navy);
  font-size: 0.75rem;
  font-weight: 800;
}
.map__hint {
  margin: 8px 0 0;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--gp-muted);
}
</style>
