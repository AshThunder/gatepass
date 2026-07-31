<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api/client'
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

async function load() {
  try {
    const res = await api.seats(props.eventId, props.tierId)
    seats.value = res.seats
    // Drop selections that are no longer available
    const ok = new Set(
      res.seats.filter(s => s.status === 'available' || selected.value.has(s.id)).map(s => s.id),
    )
    const next = props.modelValue.filter((id) => {
      const s = res.seats.find(x => x.id === id)
      return s && (s.status === 'available' || selected.value.has(id))
    })
    if (next.length !== props.modelValue.length)
      emit('update:modelValue', next.filter(id => ok.has(id)))
    error.value = ''
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function toggle(seat: SeatRecord) {
  if (seat.status === 'sold' || seat.status === 'held')
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
      <span><i class="free" /> Free</span>
      <span><i class="sel" /> Yours</span>
      <span><i class="held" /> Held</span>
      <span><i class="sold" /> Taken</span>
    </div>
    <p v-if="error" class="gp-error">
      {{ error }}
    </p>
    <svg class="map__svg" viewBox="0 0 100 100" role="img" aria-label="Seat map">
      <rect x="20" y="2" width="60" height="6" rx="1.5" fill="rgba(31,35,72,0.12)" />
      <text x="50" y="6.5" text-anchor="middle" font-size="3.2" fill="#6b7194" font-weight="700">
        STAGE
      </text>
      <circle
        v-for="s in seats"
        :key="s.id"
        :cx="s.x * 100"
        :cy="8 + s.y * 88"
        r="2.4"
        class="dot"
        :class="seatClass(s)"
        @click="toggle(s)"
      >
        <title>{{ s.label }} · {{ s.status }}</title>
      </circle>
    </svg>
    <p v-if="modelValue.length" class="map__pick">
      {{ modelValue.length }} seat{{ modelValue.length === 1 ? '' : 's' }} selected
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
  transition: r 120ms var(--gp-ease);
}
.dot.free { fill: #1f2348; }
.dot.sel { fill: #e9b213; stroke: #1f2348; stroke-width: 0.4; }
.dot.held { fill: #9aa0b8; cursor: not-allowed; }
.dot.sold { fill: #d9444f; cursor: not-allowed; opacity: 0.75; }
.dot.free:hover { r: 3; }

.map__pick {
  margin: 8px 0 0;
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--gp-navy);
}
</style>
