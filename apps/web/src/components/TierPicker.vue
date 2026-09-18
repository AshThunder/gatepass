<script setup lang="ts">
import { computed } from 'vue'
import type { TicketTier } from '@gatepass/shared'
import { lunaToNim } from '@gatepass/shared'

const props = defineProps<{
  tiers: TicketTier[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [tierId: string]
}>()

const kindLabel: Record<string, string> = {
  ga: 'General',
  vip: 'VIP',
  early_bird: 'Early bird',
  student: 'Student',
  group: 'Group',
  reserved: 'Reserved seats',
}

const sorted = computed(() =>
  [...props.tiers].sort((a, b) => a.sortOrder - b.sortOrder || a.priceLuna - b.priceLuna),
)

function price(t: TicketTier) {
  const n = lunaToNim(t.priceLuna)
  return n === 0 ? 'Free' : `${n} NIM`
}

function rem(t: TicketTier) {
  if (t.soldOut)
    return 'Sold out'
  if (t.remaining == null)
    return 'Available'
  return `${t.remaining} left`
}
</script>

<template>
  <div class="tiers" role="listbox" aria-label="Ticket types">
    <button
      v-for="t in sorted"
      :key="t.id"
      type="button"
      class="tier"
      role="option"
      :aria-selected="selectedId === t.id"
      :class="{ on: selectedId === t.id, off: !t.onSale }"
      :disabled="!t.onSale"
      @click="emit('select', t.id)"
    >
      <div class="tier__top">
        <strong>{{ t.name }}</strong>
        <span class="tier__kind">{{ kindLabel[t.kind] || t.kind }}</span>
      </div>
      <div class="tier__bottom">
        <span class="tier__price">{{ price(t) }}</span>
        <span class="tier__rem" :class="{ warn: t.soldOut || (t.remaining != null && t.remaining <= 10) }">
          {{ rem(t) }}
        </span>
      </div>
      <p v-if="t.kind === 'group'" class="tier__hint">
        Min {{ t.perOrderMin }} · max {{ t.perOrderMax }} per order
      </p>
    </button>
  </div>
</template>

<style scoped>
.tiers {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.tier {
  position: relative;
  overflow: hidden;
  text-align: left;
  border: 1px solid var(--gp-border);
  border-radius: 16px;
  padding: 12px 14px;
  min-height: var(--gp-tap);
  background: var(--gp-surface);
  color: var(--gp-navy);
  transition: border-color 140ms var(--gp-ease), background 140ms var(--gp-ease);
}
.tier.on {
  border-color: rgba(233, 178, 19, 0.7);
  background: rgba(233, 178, 19, 0.1);
  box-shadow: none;
}
.tier.off {
  opacity: 0.45;
}
.tier__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.tier__top strong {
  font-size: 0.98rem;
  letter-spacing: -0.02em;
}
.tier__kind {
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--gp-muted);
}
.tier__bottom {
  margin-top: 8px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.tier__price {
  font-weight: 500;
  color: #b8860b;
}
.tier__rem {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--gp-muted);
}
.tier__rem.warn {
  color: var(--gp-danger);
}
.tier__hint {
  margin: 6px 0 0;
  font-size: 0.72rem;
  color: var(--gp-muted);
  font-weight: 600;
}
</style>
