<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EventRecord } from '@gatepass/shared'
import { eventSharePath, lunaToNim } from '@gatepass/shared'

const props = defineProps<{
  event: EventRecord
  /** Larger “up next” treatment */
  featured?: boolean
}>()
const emit = defineEmits<{ select: [] }>()
const copied = ref(false)

const tone = computed(() => {
  let h = 0
  for (const ch of props.event.id)
    h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 6
})

const monogram = computed(() => {
  const t = props.event.title.trim()
  if (!t)
    return 'GP'
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length >= 2)
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase()
  return t.slice(0, 2).toUpperCase()
})

const dayNum = computed(() =>
  new Date(props.event.startsAt).toLocaleDateString(undefined, { day: 'numeric' }),
)
const monthLabel = computed(() =>
  new Date(props.event.startsAt).toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
)

const timing = computed(() => {
  const start = new Date(props.event.startsAt)
  const time = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const startDay = new Date(start)
  startDay.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = (startDay.getTime() - today.getTime()) / 86400000
  if (diff === 0)
    return { chip: 'Today', detail: time, hot: true }
  if (diff === 1)
    return { chip: 'Tomorrow', detail: time, hot: false }
  if (diff > 1 && diff < 7) {
    return {
      chip: start.toLocaleDateString(undefined, { weekday: 'short' }),
      detail: time,
      hot: false,
    }
  }
  return {
    chip: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    detail: time,
    hot: false,
  }
})

const priceLabel = computed(() => {
  if (props.event.soldOut)
    return 'Sold out'
  const nim = lunaToNim(props.event.priceLuna)
  const base = nim === 0 ? 'Free' : `${nim} NIM`
  if ((props.event.tiers?.length || 0) > 1 && nim > 0)
    return `From ${base}`
  return base
})

const isPast = computed(() => Date.now() > new Date(props.event.endsAt).getTime())
const isFree = computed(() => !props.event.soldOut && lunaToNim(props.event.priceLuna) === 0)

const urgency = computed(() => {
  if (props.event.soldOut)
    return { text: 'Sold out', warn: true }
  if (props.event.remaining != null && props.event.remaining <= 10)
    return { text: `${props.event.remaining} left`, warn: true }
  if (!props.event.hideSoldCount && props.event.soldCount > 0)
    return { text: `${props.event.soldCount} going`, warn: false }
  if (props.event.hideSoldCount)
    return { text: '', warn: false }
  return { text: 'Just listed', warn: false }
})

const shareUrl = computed(() =>
  `${window.location.origin}${window.location.pathname}${eventSharePath(props.event.id)}`,
)

async function copyLink(e: Event) {
  e.stopPropagation()
  try {
    await navigator.clipboard.writeText(shareUrl.value)
  }
  catch {
    const ta = document.createElement('textarea')
    ta.value = shareUrl.value
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 1500)
}
</script>

<template>
  <article
    class="pass"
    :class="[`tone-${tone}`, { past: isPast, featured }]"
    role="button"
    tabindex="0"
    @click="emit('select')"
    @keydown.enter.prevent="emit('select')"
    @keydown.space.prevent="emit('select')"
  >
    <div class="pass__date" aria-hidden="true">
      <span class="pass__month">{{ monthLabel }}</span>
      <span class="pass__day">{{ dayNum }}</span>
    </div>

    <div class="pass__main">
      <div class="pass__chips">
        <span class="chip" :class="{ hot: timing.hot }">{{ timing.chip }}</span>
        <span v-if="isFree && !isPast" class="chip soft">Free</span>
        <span v-else-if="urgency.warn && !isPast" class="chip warn">{{ urgency.text }}</span>
      </div>

      <h3 class="pass__title">
        {{ event.title }}
      </h3>

      <p class="pass__meta">
        <span>{{ timing.detail }}</span>
        <span class="dot" aria-hidden="true">·</span>
        <span class="venue">{{ event.venueName }}</span>
      </p>

      <div class="pass__cta">
        <span class="pass__price" :class="{ muted: isPast || event.soldOut }">
          <svg v-if="!isPast && !event.soldOut" class="hex" viewBox="0 0 32 32" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13L16 2.5Z" />
          </svg>
          {{ isPast ? 'Ended' : priceLabel }}
        </span>
        <span v-if="urgency.text && !urgency.warn && !isPast && !isFree" class="pass__going">{{ urgency.text }}</span>
        <button
          type="button"
          class="pass__share"
          :aria-label="copied ? 'Copied' : 'Share'"
          @click="copyLink"
        >
          {{ copied ? '✓' : '↗' }}
        </button>
      </div>
    </div>

    <div class="pass__perf" aria-hidden="true" />

    <div
      class="pass__art"
      :class="{ photo: !!event.coverUrl }"
      :style="event.coverUrl ? { backgroundImage: `url(${event.coverUrl})` } : undefined"
    >
      <span v-if="!event.coverUrl" class="pass__mono">{{ monogram }}</span>
      <span class="pass__go" aria-hidden="true">›</span>
    </div>
  </article>
</template>

<style scoped>
.pass {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr) 8px 72px;
  align-items: stretch;
  min-height: 92px;
  background: #fff;
  border: 1px solid rgba(31, 35, 72, 0.1);
  border-radius: 16px;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.8) inset,
    0 8px 20px rgba(31, 35, 72, 0.06);
  cursor: pointer;
  overflow: hidden;
  transition: transform 170ms var(--gp-ease), box-shadow 170ms var(--gp-ease);
}
.pass:active {
  transform: scale(0.985);
}
.pass.past {
  opacity: 0.55;
}
.pass.featured {
  grid-template-columns: 50px minmax(0, 1fr) 8px 84px;
  min-height: 104px;
  border-color: rgba(233, 178, 19, 0.4);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.8) inset,
    0 10px 24px rgba(31, 35, 72, 0.08);
}

.pass__date {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  background: #f7f5ef;
  border-right: 1px solid rgba(31, 35, 72, 0.06);
  color: var(--gp-navy);
}
.pass__month {
  font-size: 0.55rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--gp-muted);
}
.pass__day {
  font-size: 1.15rem;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
}
.pass.featured .pass__day {
  font-size: 1.28rem;
}

.pass__main {
  min-width: 0;
  padding: 8px 2px 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pass__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 0.6rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  background: rgba(31, 35, 72, 0.07);
  color: var(--gp-navy);
}
.chip.hot {
  background: rgba(233, 178, 19, 0.28);
  color: #7a5a00;
}
.chip.soft {
  background: rgba(33, 188, 165, 0.14);
  color: #0f7a6b;
}
.chip.warn {
  background: rgba(217, 68, 79, 0.12);
  color: var(--gp-danger);
}

.pass__title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 800;
  letter-spacing: -0.025em;
  line-height: 1.2;
  color: var(--gp-navy);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pass.featured .pass__title {
  font-size: 1rem;
}

.pass__meta {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--gp-muted);
}
.pass__meta .dot {
  opacity: 0.45;
}
.pass__meta .venue {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pass__cta {
  margin-top: auto;
  padding-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pass__price {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.82rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: #b8860b;
}
.pass__price .hex {
  color: var(--gp-gold);
  width: 10px;
  height: 10px;
}
.pass__price.muted {
  color: var(--gp-muted);
}
.pass__going {
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--gp-muted);
}
.pass__share {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border: 1px solid var(--gp-border);
  border-radius: 999px;
  background: #fff;
  color: var(--gp-navy);
  font-weight: 800;
  font-size: 0.8rem;
}

.pass__perf {
  width: 8px;
  margin: 8px 0;
  background:
    repeating-linear-gradient(
      180deg,
      transparent 0 6px,
      rgba(31, 35, 72, 0.2) 6px 7px
    );
  border-left: 1px dashed rgba(31, 35, 72, 0.16);
  border-right: 1px dashed rgba(31, 35, 72, 0.16);
}

.pass__art {
  position: relative;
  background: #1f2348;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pass__art.photo {
  background-color: #c8cde0;
  background-size: cover;
  background-position: center;
}
.pass__mono {
  font-size: 1.15rem;
  font-weight: 800;
  letter-spacing: -0.04em;
  color: rgba(255, 255, 255, 0.92);
}
.pass.featured .pass__mono {
  font-size: 1.3rem;
}
.pass__go {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--gp-navy);
  font-size: 0.85rem;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
}
</style>
