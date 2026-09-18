<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EventRecord } from '@gatepass/shared'
import { eventSharePath, lunaToNim } from '@gatepass/shared'
import { copyToClipboard } from '@/lib/copy'

const props = defineProps<{
  event: EventRecord
}>()

const status = ref('')

const shareUrl = computed(() =>
  `${window.location.origin}${window.location.pathname}${eventSharePath(props.event.id)}`,
)

const when = computed(() =>
  new Date(props.event.startsAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }),
)

const price = computed(() => {
  const nim = lunaToNim(props.event.priceLuna)
  if (props.event.soldOut)
    return 'Sold out'
  if (nim === 0)
    return 'Free'
  if ((props.event.tiers?.length || 0) > 1)
    return `From ${nim} NIM`
  return `${nim} NIM`
})

async function copy() {
  const ok = await copyToClipboard(shareUrl.value)
  status.value = ok ? 'Link copied' : 'Could not copy — use Share, or long-press the address bar'
  setTimeout(() => {
    status.value = ''
  }, 2000)
}

async function share() {
  if (navigator.share) {
    try {
      await navigator.share({
        title: props.event.title,
        text: `${props.event.title} · ${when.value} · ${props.event.venueName}`,
        url: shareUrl.value,
      })
      return
    }
    catch { /* fall through */ }
  }
  await copy()
}
</script>

<template>
  <div class="share-card">
    <div class="share-card__body">
      <p class="share-card__eyebrow">
        {{ event.hallSlotId ? 'Nimiq Hall' : 'GatePass' }}
      </p>
      <h3>{{ event.title }}</h3>
      <p>{{ when }}</p>
      <p>{{ event.venueName }} · {{ price }}</p>
    </div>
    <div class="share-card__actions">
      <button class="gp-btn secondary sm" type="button" @click="share">
        Share
      </button>
      <button class="gp-btn ghost sm" type="button" @click="copy">
        Copy link
      </button>
    </div>
    <p v-if="status" class="share-card__status">
      {{ status }}
    </p>
  </div>
</template>

<style scoped>
.share-card {
  margin: 12px 0;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid var(--gp-border);
  background:
    linear-gradient(135deg, rgba(233, 178, 19, 0.12), transparent 55%),
    #fff;
}
.share-card__eyebrow {
  margin: 0 0 4px;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #b8860b;
}
.share-card__body h3 {
  margin: 0 0 6px;
  font-size: 1.05rem;
  letter-spacing: -0.02em;
}
.share-card__body p {
  margin: 0 0 2px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--gp-muted);
}
.share-card__actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.share-card__status {
  margin: 8px 0 0;
  font-size: 0.78rem;
  font-weight: 700;
  color: #0f7a6b;
}
</style>
