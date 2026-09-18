<script setup lang="ts">
defineProps<{
  current: number
  steps: Array<{ title: string }>
}>()

function stateOf(index: number, current: number) {
  if (index < current)
    return 'done'
  if (index === current)
    return 'now'
  return 'todo'
}

function lineOf(index: number, current: number) {
  if (current > index)
    return 'done'
  if (current === index)
    return 'now'
  return 'todo'
}

function statusLabel(index: number, current: number) {
  if (index < current)
    return 'Completed'
  if (index === current)
    return 'In Progress'
  return 'Pending'
}
</script>

<template>
  <ol class="stepper" aria-label="Gate steps">
    <li
      v-for="(step, i) in steps"
      :key="step.title"
      class="stepper__item"
      :class="[stateOf(i, current), i < steps.length - 1 ? `line-${lineOf(i, current)}` : '']"
      :aria-current="i === current ? 'step' : undefined"
    >
      <span class="stepper__dot" aria-hidden="true">
        <svg v-if="i < current" viewBox="0 0 16 16">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3.5 8.5 6.5 11.5 12.5 4.5"
          />
        </svg>
      </span>
      <p class="stepper__kicker">
        Step {{ i + 1 }}
      </p>
      <p class="stepper__title">
        {{ step.title }}
      </p>
      <p class="stepper__status">
        {{ statusLabel(i, current) }}
      </p>
    </li>
  </ol>
</template>

<style scoped>
.stepper {
  display: flex;
  list-style: none;
  margin: 0 0 16px;
  padding: 22px 6px 16px;
  background: #fff;
  border-radius: 28px;
  box-shadow: 0 12px 40px rgba(31, 35, 72, 0.1);
}

.stepper__item {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.stepper__item:not(:last-child)::before {
  content: '';
  position: absolute;
  top: 10px;
  left: calc(50% + 15px);
  width: calc(100% - 30px);
  height: 2px;
  border-radius: 2px;
  background: #c5dbff;
}

.stepper__item.line-done::before {
  background: #16a34a;
}

.stepper__item.line-now::before {
  background: #2563eb;
}

.stepper__dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  margin-bottom: 10px;
  color: #fff;
  background: #c5dbff;
  z-index: 1;
}

.stepper__dot svg {
  width: 12px;
  height: 12px;
}

.stepper__item.done .stepper__dot {
  background: #16a34a;
}

.stepper__item.now .stepper__dot {
  background: #2563eb;
  box-shadow: 0 0 0 5px rgba(37, 99, 235, 0.22);
}

.stepper__kicker {
  margin: 0;
  font-size: 0.58rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--gp-muted);
}

.stepper__title {
  margin: 2px 0 0;
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--gp-navy);
  line-height: 1.2;
}

.stepper__status {
  margin: 3px 0 0;
  font-size: 0.62rem;
  font-weight: 600;
}

.stepper__item.done .stepper__status {
  color: #16a34a;
}

.stepper__item.now .stepper__status {
  color: #2563eb;
}

.stepper__item.todo .stepper__status {
  color: #93b4e8;
}

@media (max-width: 360px) {
  .stepper__kicker {
    display: none;
  }
  .stepper__title {
    font-size: 0.66rem;
  }
}
</style>
