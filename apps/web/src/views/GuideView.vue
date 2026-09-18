<script setup lang="ts">
const emit = defineEmits<{
  close: []
  goTab: [tab: 'discover' | 'tickets' | 'host' | 'gate']
}>()
</script>

<template>
  <section class="guide">
    <button class="gp-back" type="button" @click="emit('close')">
      ← Back
    </button>
    <h1 class="gp-page-title">
      Guide
    </h1>
    <p class="gp-page-sub">
      How GatePass works — buy, host, Nimiq Hall, and the door.
    </p>

    <div class="gp-card">
      <h2 class="gp-h2">
        In one minute
      </h2>
      <ol class="steps">
        <li>
          <strong>Discover</strong> an event (or Host creates / rents the hall).
        </li>
        <li>
          Guest <strong>pays with NIM</strong> in Nimiq Pay.
        </li>
        <li>
          Ticket lives under <strong>Tickets</strong> as a rotating QR.
        </li>
        <li>
          Host taps <strong>Check in guests</strong> on the event; staff type the door PIN on Gate.
        </li>
      </ol>
    </div>

    <div class="gp-card">
      <h2 class="gp-h2">
        Guest
      </h2>
      <ul class="bullets">
        <li>Browse Discover → open an event → pick ticket type or seats.</li>
        <li>Reserved maps show row letters (e.g. <em>A-12</em>). Seats stay held for a few minutes while you pay.</li>
        <li>Pay with NIM (memo is automatic). After success, open <strong>Tickets</strong> for your pass.</li>
        <li>At the door, show the live QR — not a screenshot of an old code.</li>
      </ul>
      <button class="gp-btn ghost sm" type="button" @click="emit('goTab', 'discover')">
        Open Discover
      </button>
    </div>

    <div class="gp-card">
      <h2 class="gp-h2">
        Host
      </h2>
      <ul class="bullets">
        <li>
          <strong>Create</strong> — title, venue, price, capacity. A door PIN is generated for you.
        </li>
        <li>
          After create, open <strong>My events</strong>: share the guest link, then tap Check in guests to scan tickets.
        </li>
        <li>
          Give the door PIN to staff. They open Gate and type it — no host QR needed.
        </li>
        <li>
          Share the event link (or use the share card). Guests pay your payout address.
        </li>
        <li>
          Optional Advanced tiers: VIP, group, or reserved seat maps.
        </li>
      </ul>
      <button class="gp-btn ghost sm" type="button" @click="emit('goTab', 'host')">
        Open Host
      </button>
    </div>

    <div class="gp-card">
      <h2 class="gp-h2">
        Nimiq Hall
      </h2>
      <ul class="bullets">
        <li>Platform venue with <em>100 labeled seats</em> (rows A–J).</li>
        <li>On Host (or Discover → Book Nimiq Hall): pick an open night → pay rent in NIM → your event goes live on that map.</li>
        <li>Guests buy individual seats; you get ticket payouts as usual. Capacity cannot exceed 100.</li>
      </ul>
    </div>

    <div class="gp-card">
      <h2 class="gp-h2">
        Gate (door staff)
      </h2>
      <ul class="bullets">
        <li>
          Hosts: on My events, tap <strong>Check in guests</strong> — Gate opens already unlocked.
        </li>
        <li>
          Staff: open <strong>Gate</strong>, type the door PIN from the host, then scan guest tickets.
        </li>
        <li>
          Then scan each guest’s ticket. Big ACCEPT / DENY.
        </li>
        <li>
          Use <strong>Tablet</strong> for larger targets and keep-awake when supported (`?tab=gate&tablet=1`).
        </li>
        <li>
          Offline: failed check-ins queue and sync when the network returns.
        </li>
      </ul>
      <button class="gp-btn ghost sm" type="button" @click="emit('goTab', 'gate')">
        Open Gate
      </button>
    </div>

    <div class="gp-card">
      <h2 class="gp-h2">
        Tips
      </h2>
      <ul class="bullets">
        <li>Open GatePass inside <em>Nimiq Pay → Mini Apps</em> for real wallet payments.</li>
        <li>Camera needs HTTPS (or localhost). Paste unlock / ticket codes if the camera is blocked.</li>
        <li>Pay with NIM inside Nimiq Pay — the memo is filled in for you.</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.steps {
  margin: 0;
  padding-left: 1.2rem;
  color: var(--gp-muted);
  font-size: 0.92rem;
  line-height: 1.55;
}
.steps li + li {
  margin-top: 8px;
}
.steps strong {
  color: var(--gp-navy);
  font-weight: 500;
}
.bullets {
  margin: 0 0 12px;
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
  font-weight: 500;
  color: var(--gp-navy);
}
.gp-card .gp-btn {
  width: auto;
}
</style>
