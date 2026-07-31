<script setup lang="ts">
defineEmits<{ close: [] }>()
</script>

<template>
  <section class="privacy">
    <button class="gp-back" type="button" @click="$emit('close')">
      ← Back
    </button>
    <h1 class="gp-page-title">
      Privacy
    </h1>
    <p class="gp-page-sub">
      What GatePass stores — and what it never sees.
    </p>

    <div class="gp-card">
      <h2 class="gp-h2">
        On the server
      </h2>
      <ul class="bullets">
        <li>Event title, times, venue, optional map pin & cover URL</li>
        <li>Organizer NIM address and ticket price / capacity</li>
        <li>Ticket ids, buyer addresses, payment tx hashes</li>
        <li>Ticket seeds (derived) and redeem / cancel timestamps</li>
        <li>Optional staff passcode <em>hash</em> (never the PIN itself)</li>
        <li>Waitlist addresses for sold-out events</li>
      </ul>
    </div>

    <div class="gp-card">
      <h2 class="gp-h2">
        On your device
      </h2>
      <ul class="bullets">
        <li>Your ticket passes (including seeds) in local storage</li>
        <li>Gate offline cache & pending check-in queue</li>
        <li>Local event reminders (if you enable them)</li>
      </ul>
    </div>

    <div class="gp-card">
      <h2 class="gp-h2">
        We never store
      </h2>
      <ul class="bullets">
        <li>Private keys or seed phrases</li>
        <li>Nimiq Pay login credentials</li>
        <li>Camera footage (scanning stays on-device)</li>
      </ul>
      <p class="gp-sub" style="margin: 12px 0 0;">
        Wallet payments go through Nimiq Pay’s own confirm dialogs. GatePass only receives addresses and transaction hashes you approve.
      </p>
    </div>
  </section>
</template>

<style scoped>
.bullets {
  margin: 0;
  padding-left: 1.15rem;
  color: var(--gp-muted);
  font-size: 0.92rem;
  line-height: 1.55;
}
.bullets li + li {
  margin-top: 6px;
}
.bullets em {
  font-style: normal;
  font-weight: 700;
  color: var(--gp-navy);
}
</style>
