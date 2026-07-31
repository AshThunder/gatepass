<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EventRecord, TicketRecord } from '@gatepass/shared'
import { isBadgePhase } from '@gatepass/shared'

const props = defineProps<{
  event: EventRecord
  ticket: TicketRecord
  /** Force show badge UI for demos */
  preview?: boolean
}>()

const downloading = ref(false)

const dateLabel = computed(() =>
  new Date(props.event.startsAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }),
)

const showAsBadge = computed(() =>
  props.preview || (props.ticket.status === 'redeemed' && isBadgePhase(props.event.endsAt)),
)

async function downloadCard() {
  downloading.value = true
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 720
    canvas.height = 960
    const ctx = canvas.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 0, 960)
    g.addColorStop(0, '#1F2348')
    g.addColorStop(1, '#151833')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 720, 960)
    ctx.fillStyle = '#E9B213'
    ctx.beginPath()
    const cx = 360
    const cy = 220
    const r = 70
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6
      const x = cx + r * Math.cos(a)
      const y = cy + r * Math.sin(a)
      if (i === 0)
        ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 42px Mulish, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Proof of Attendance', 360, 360)
    ctx.font = '28px Mulish, sans-serif'
    ctx.fillText(props.event.title.slice(0, 32), 360, 430)
    ctx.font = '22px Mulish, sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    ctx.fillText(dateLabel.value, 360, 480)
    ctx.fillText(props.event.venueName.slice(0, 40), 360, 520)
    ctx.font = '16px Fira Mono, monospace'
    ctx.fillText(props.ticket.id, 360, 600)
    ctx.fillText('GatePass · Nimiq', 360, 880)

    const url = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `gatepass-poa-${props.ticket.id}.png`
    a.click()
  }
  finally {
    downloading.value = false
  }
}
</script>

<template>
  <div v-if="showAsBadge" class="gp-badge">
    <svg class="gp-hex" viewBox="0 0 32 32" width="48" height="48" aria-hidden="true">
      <path fill="#E9B213" d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13L16 2.5Z" />
    </svg>
    <h2>{{ preview && ticket.status !== 'redeemed' ? 'Badge preview' : 'Proof of Attendance' }}</h2>
    <p>{{ event.title }}</p>
    <p>{{ dateLabel }}</p>
    <p style="margin-top: 14px; opacity: 0.7; font-size: 0.8rem;">
      Non-transferable collectible · {{ ticket.status }}
    </p>
    <p class="gp-mono" style="margin-top: 10px; opacity: 0.65;">
      {{ ticket.id }}
    </p>
    <button
      class="gp-btn"
      type="button"
      style="margin-top: 16px; max-width: 280px;"
      :disabled="downloading"
      @click="downloadCard"
    >
      {{ downloading ? 'Preparing…' : 'Download share card' }}
    </button>
  </div>
</template>
