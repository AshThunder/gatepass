<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  seats: Array<{
    label: string
    rowKey: string
    x: number
    y: number
  }>
}>()

const rowKeys = computed(() => {
  const keys = [...new Set(props.seats.map(s => s.rowKey))]
  return keys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
})

function rowLabelPos(rowKey: string) {
  const row = props.seats.filter(s => s.rowKey === rowKey)
  if (!row.length)
    return { x: 2, y: 50 }
  const y = 8 + (row.reduce((s, r) => s + r.y, 0) / row.length) * 88
  return { x: 3.5, y }
}
</script>

<template>
  <div class="preview">
    <div class="preview__legend">
      <span><i /> {{ seats.length }} seats · rows A–J</span>
    </div>
    <svg class="preview__svg" viewBox="0 0 100 100" role="img" aria-label="Nimiq Hall seat preview">
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
        :key="s.label"
        :cx="s.x * 100"
        :cy="8 + s.y * 88"
        r="2.1"
        class="dot"
      >
        <title>{{ s.label }}</title>
      </circle>
    </svg>
  </div>
</template>

<style scoped>
.preview {
  margin-top: 10px;
}
.preview__legend {
  margin-bottom: 6px;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--gp-muted);
}
.preview__legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  margin-right: 4px;
  vertical-align: middle;
  background: #1f2348;
}
.preview__svg {
  width: 100%;
  aspect-ratio: 1.15;
  background: var(--gp-surface-soft);
  border-radius: 14px;
  border: 1px solid var(--gp-border);
}
.dot {
  fill: #1f2348;
}
</style>
