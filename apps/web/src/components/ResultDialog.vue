<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  open: boolean
  kind: 'success' | 'fail'
  title: string
  message: string
  eventTitle?: string
  tier?: string
  amount?: string
}>(), {
  eventTitle: '',
  tier: '',
  amount: '',
})

const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)

function onCancel(ev: Event) {
  ev.preventDefault()
  emit('close')
}

watch(
  () => [props.open, dialog.value] as const,
  ([open, el]) => {
    if (!el)
      return
    if (open && !el.open)
      el.showModal()
    else if (!open && el.open)
      el.close()
  },
  { flush: 'post' },
)

onUnmounted(() => {
  dialog.value?.close()
})
</script>

<template>
  <dialog
    ref="dialog"
    class="result-dialog"
    @cancel="onCancel"
    @click.self="emit('close')"
  >
    <div class="result-dialog__card" :class="kind">
      <p class="result-dialog__kind">
        {{ kind === 'success' ? 'Success' : 'Couldn’t complete' }}
      </p>
      <h2 class="gp-h2">
        {{ title }}
      </h2>
      <p v-if="eventTitle" class="result-dialog__meta">
        {{ eventTitle }}
        <template v-if="tier">
          · {{ tier }}
        </template>
        <template v-if="amount">
          · {{ amount }}
        </template>
      </p>
      <p class="gp-sub">
        {{ message }}
      </p>
      <button class="gp-btn" type="button" @click="emit('close')">
        {{ kind === 'success' ? 'Done' : 'Close' }}
      </button>
    </div>
  </dialog>
</template>

<style scoped>
.result-dialog {
  border: 0;
  padding: 0;
  background: transparent;
  max-width: min(400px, calc(100vw - 32px));
}
.result-dialog::backdrop {
  background: rgba(31, 35, 72, 0.4);
}
.result-dialog__card {
  border-radius: 16px;
  padding: 20px 16px 16px;
  background: var(--gp-surface);
  box-shadow: 0 8px 32px rgba(31, 35, 72, 0.24);
}
.result-dialog__kind {
  margin: 0 0 6px;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--gp-success);
}
.result-dialog__card.fail .result-dialog__kind {
  color: var(--gp-danger);
}
.result-dialog__meta {
  margin: 0 0 8px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--gp-navy);
}
</style>
