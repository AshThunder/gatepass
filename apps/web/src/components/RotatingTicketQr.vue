<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import QRCode from 'qrcode'
import { encodeQrPayload, generateTotp, totpSecondsRemaining } from '@/crypto/ticket'
import { TOTP_PERIOD_SECONDS } from '@gatepass/shared'
import { copyToClipboard } from '@/lib/copy'

const props = withDefaults(defineProps<{
  eventId: string
  ticketId: string
  ticketSeed: string
  /** Dark pass chrome: white QR plate, light text */
  variant?: 'light' | 'pass'
}>(), {
  variant: 'light',
})

const qrDataUrl = ref('')
const remaining = ref(TOTP_PERIOD_SECONDS)
const code = ref('')
const payload = ref('')
const copyStatus = ref('')
const showRaw = ref(false)
let timer: number | undefined
let lastCode = ''

const progress = computed(() => (remaining.value / TOTP_PERIOD_SECONDS) * 100)
const isPass = computed(() => props.variant === 'pass')

async function updateQrIfNeeded(nextCode: string) {
  if (nextCode === lastCode && qrDataUrl.value)
    return
  lastCode = nextCode
  payload.value = encodeQrPayload({
    eventId: props.eventId,
    ticketId: props.ticketId,
    totp: nextCode,
  })
  qrDataUrl.value = await QRCode.toDataURL(payload.value, {
    width: 280,
    margin: 1,
    color: { dark: '#1F2348', light: '#FFFFFF' },
  })
}

async function tick() {
  const now = Date.now()
  remaining.value = totpSecondsRemaining(now)
  try {
    const next = await generateTotp(props.ticketSeed, now)
    code.value = next
    await updateQrIfNeeded(next)
  }
  catch (err) {
    copyStatus.value = err instanceof Error ? err.message : String(err)
  }
}

async function copyPayload() {
  copyStatus.value = ''
  if (!payload.value) {
    copyStatus.value = 'Ticket string not ready yet'
    return
  }

  try {
    const ok = await copyToClipboard(payload.value)
    if (ok) {
      copyStatus.value = 'Copied'
      setTimeout(() => {
        if (copyStatus.value === 'Copied')
          copyStatus.value = ''
      }, 2000)
      return
    }
  }
  catch { /* fall through */ }

  try {
    if (navigator.share) {
      await navigator.share({ text: payload.value })
      copyStatus.value = 'Shared'
      return
    }
  }
  catch { /* cancelled */ }

  showRaw.value = true
  copyStatus.value = 'Select the text below and copy'
}

onMounted(() => {
  void tick()
  timer = window.setInterval(() => void tick(), 250)
})

onUnmounted(() => {
  if (timer)
    clearInterval(timer)
})

watch(() => [props.ticketSeed, props.ticketId, props.eventId], () => {
  lastCode = ''
  void tick()
})
</script>

<template>
  <div class="tqr" :class="variant">
    <div class="tqr__plate">
      <img v-if="qrDataUrl" :src="qrDataUrl" alt="Ticket QR" width="260" height="260">
      <div v-else class="tqr__skeleton" aria-hidden="true" />
    </div>

    <div class="tqr__timer" aria-hidden="true">
      <div class="tqr__bar">
        <span :style="{ width: `${progress}%` }" />
      </div>
    </div>

    <div class="tqr__code">
      <span class="tqr__digits">{{ code || '······' }}</span>
      <span class="tqr__left">{{ remaining }}s</span>
    </div>

    <button class="tqr__copy" type="button" @click="copyPayload">
      {{ copyStatus === 'Copied' ? 'Copied' : 'Copy check-in code' }}
    </button>

    <button class="tqr__toggle" type="button" @click="showRaw = !showRaw">
      {{ showRaw ? 'Hide string' : 'Show string' }}
    </button>

    <textarea
      v-if="showRaw"
      class="tqr__raw"
      readonly
      rows="2"
      :value="payload"
      @focus="($event.target as HTMLTextAreaElement).select()"
    />
    <p v-if="copyStatus && copyStatus !== 'Copied'" class="tqr__err">
      {{ copyStatus }}
    </p>
    <p v-if="!isPass" class="tqr__note">
      Rotates every {{ TOTP_PERIOD_SECONDS }}s
    </p>
  </div>
</template>

<style scoped>
.tqr {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  gap: 10px;
}

.tqr__plate {
  padding: 14px;
  border-radius: 20px;
  background: #fff;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}
.tqr__plate img {
  display: block;
  width: min(260px, 68vw);
  height: auto;
  aspect-ratio: 1;
}
.tqr__skeleton {
  width: min(260px, 68vw);
  aspect-ratio: 1;
  border-radius: 8px;
  background: linear-gradient(90deg, #eceef5, #f7f8fc, #eceef5);
  background-size: 200% 100%;
  animation: shimmer 1.2s ease-in-out infinite;
}

.tqr__timer {
  width: min(260px, 68vw);
}
.tqr__bar {
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  overflow: hidden;
}
.tqr.light .tqr__bar {
  background: rgba(31, 35, 72, 0.1);
}
.tqr__bar > span {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #e9b213, #f5d56a);
  transition: width 0.2s linear;
}

.tqr__code {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-family: var(--gp-mono);
}
.tqr__digits {
  font-size: 1.55rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: #fff;
}
.tqr.light .tqr__digits {
  color: var(--gp-navy);
}
.tqr__left {
  font-size: 0.85rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.65);
  letter-spacing: 0.04em;
}
.tqr.light .tqr__left {
  color: var(--gp-muted);
}

.tqr__copy {
  border: 0;
  border-radius: 999px;
  padding: 11px 20px;
  font-weight: 800;
  font-size: 0.88rem;
  background: #e9b213;
  color: #1f2348;
  min-width: 200px;
}
.tqr__toggle {
  border: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font-weight: 700;
  font-size: 0.8rem;
  padding: 4px;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.tqr.light .tqr__toggle {
  color: var(--gp-muted);
}
.tqr__raw {
  width: 100%;
  max-width: 280px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 12px;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.25);
  color: #fff;
  font-family: var(--gp-mono);
  font-size: 0.72rem;
  resize: none;
}
.tqr.light .tqr__raw {
  border-color: var(--gp-border);
  background: var(--gp-surface-soft);
  color: var(--gp-navy);
}
.tqr__err {
  margin: 0;
  color: #ff8b93;
  font-size: 0.82rem;
  text-align: center;
}
.tqr.light .tqr__err {
  color: var(--gp-danger);
}
.tqr__note {
  margin: 0;
  font-size: 0.75rem;
  color: var(--gp-muted);
}

@keyframes shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
</style>
