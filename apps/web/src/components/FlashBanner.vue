<script setup lang="ts">
import { onUnmounted, watch } from 'vue'

const props = withDefaults(defineProps<{
  message: string
  kind?: 'error' | 'success'
  /** 0 = stay until dismissed */
  ttlMs?: number
}>(), {
  kind: 'error',
  ttlMs: 6500,
})

const emit = defineEmits<{ clear: [] }>()

let timer: ReturnType<typeof setTimeout> | null = null

function dismiss() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  emit('clear')
}

function arm() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!props.message || props.ttlMs <= 0)
    return
  timer = setTimeout(() => {
    timer = null
    emit('clear')
  }, props.ttlMs)
}

watch(() => props.message, () => arm(), { immediate: true })
onUnmounted(() => {
  if (timer)
    clearTimeout(timer)
})
</script>

<template>
  <p
    v-if="message"
    class="flash"
    :class="kind"
    role="alert"
    @click="dismiss"
  >
    <span class="flash__text">{{ message }}</span>
    <button
      class="flash__x"
      type="button"
      aria-label="Dismiss"
      @click.stop="dismiss"
    >
      ×
    </button>
  </p>
</template>

<style scoped>
.flash {
  position: fixed;
  left: 50%;
  bottom: calc(var(--gp-tabbar-h) + env(safe-area-inset-bottom, 0px) + 12px);
  transform: translateX(-50%);
  width: min(448px, calc(100% - 32px));
  z-index: 50;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 14px 16px;
  border-radius: 4px;
  font-size: 0.875rem;
  font-weight: 400;
  line-height: 1.35;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(31, 35, 72, 0.24);
}
.flash.error {
  color: #fff;
  background: #322f35;
}
.flash.success {
  color: #fff;
  background: #322f35;
}
.flash__text {
  flex: 1;
  min-width: 0;
}
.flash__x {
  flex: none;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 1.2rem;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  opacity: 0.7;
}
.flash__x:hover {
  opacity: 1;
}
</style>
