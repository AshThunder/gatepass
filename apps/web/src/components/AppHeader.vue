<script setup lang="ts">
defineProps<{ title?: string }>()
</script>

<template>
  <header class="gp-header">
    <div class="gp-brand">
      <svg class="gp-hex" viewBox="0 0 32 32" aria-hidden="true">
        <path
          fill="#E9B213"
          d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13L16 2.5Z"
        />
        <path
          fill="#1F2348"
          d="M16 7.2 23.5 11.5v9L16 24.8 8.5 20.5v-9L16 7.2Z"
          opacity="0.28"
        />
      </svg>
      <span>{{ title || 'GatePass' }}</span>
    </div>
    <slot name="right">
      <span class="gp-pill muted">Nimiq Pay</span>
    </slot>
  </header>
</template>
