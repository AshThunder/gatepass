import type { Context } from 'hono'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  CreateEventRequest,
  CreateTierInput,
  EventRecord,
  GuestRow,
  HoldRequest,
  HoldResponse,
  InventorySnapshot,
  PurchaseItem,
  SeatRecord,
  SeatTemplateId,
  TicketRecord,
  TicketStatus,
  TicketTier,
  WaitlistEntry,
} from '@gatepass/shared'
import {
  HOLD_TTL_MS,
  addressesEqual,
  deriveTicketSeed,
  generateMasterSecret,
  isNqAddress,
  nimToLuna,
  paymentMemo,
  tierOnSale,
  verifyTotp,
} from '@gatepass/shared'
import { nanoid } from 'nanoid'
import {
  db,
  type EventRow,
  type HoldRow,
  type SeatRow,
  type TicketRow,
  type TierRow,
  type WaitlistRow,
} from '../db.js'
import {
  allowSkipVerify,
  assertPaymentMatches,
  waitForTransaction,
} from '../nimiq-rpc.js'
import { generateSeatLayout, NIMIQ_HALL_CAPACITY } from '../seat-templates.js'

function hashStaffPass(passcode: string, salt: string) {
  return createHash('sha256').update(`${salt}:${passcode}`).digest('hex')
}

function normalizePasscode(raw: string) {
  return raw.trim()
}

function setStaffPassFields(passcode: string | null | undefined): { salt: string | null, hash: string | null } {
  const pass = passcode ? normalizePasscode(passcode) : ''
  if (!pass)
    return { salt: null, hash: null }
  if (pass.length < 4 || pass.length > 32)
    throw new HttpError(400, 'staffPasscode must be 4–32 characters')
  const salt = randomBytes(16).toString('hex')
  return { salt, hash: hashStaffPass(pass, salt) }
}

function verifyStaffPass(event: EventRow, passcode: string) {
  if (!event.staff_pass_hash || !event.staff_pass_salt)
    throw new HttpError(404, 'No staff passcode set for this event')
  const hash = hashStaffPass(normalizePasscode(passcode), event.staff_pass_salt)
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(event.staff_pass_hash, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new HttpError(403, 'Invalid staff passcode')
}

function releaseExpiredHolds() {
  const now = new Date().toISOString()
  const expired = db.prepare(`SELECT id FROM holds WHERE expires_at < ?`).all(now) as Array<{ id: string }>
  for (const h of expired) {
    db.prepare(`
      UPDATE seats SET status = 'available', held_until = NULL, held_by = NULL, hold_id = NULL
      WHERE hold_id = ? AND status = 'held'
    `).run(h.id)
    db.prepare(`DELETE FROM holds WHERE id = ?`).run(h.id)
  }
}

function tierSoldCount(tierId: string) {
  return (db.prepare(
    `SELECT COUNT(*) AS c FROM tickets WHERE tier_id = ? AND status != 'cancelled'`,
  ).get(tierId) as { c: number }).c
}

function seatOccupiedExtra(tierId: string) {
  // Held seats (not yet sold) also reduce remaining for reserved tiers
  return (db.prepare(
    `SELECT COUNT(*) AS c FROM seats WHERE tier_id = ? AND status = 'held'
      AND (held_until IS NULL OR held_until >= ?)`,
  ).get(tierId, new Date().toISOString()) as { c: number }).c
}

function tierFromRow(row: TierRow): TicketTier {
  const sold = tierSoldCount(row.id)
  const held = row.kind === 'reserved' ? seatOccupiedExtra(row.id) : 0
  const capacity = row.capacity == null ? null : Number(row.capacity)
  const used = sold + held
  const remaining = capacity == null ? null : Math.max(0, capacity - used)
  const soldOut = capacity != null && used >= capacity
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    kind: row.kind,
    priceLuna: row.price_luna,
    capacity,
    perOrderMin: row.per_order_min,
    perOrderMax: row.per_order_max,
    salesStartsAt: row.sales_starts_at,
    salesEndsAt: row.sales_ends_at,
    mapTemplate: row.map_template,
    mapSection: row.map_section,
    sortOrder: row.sort_order,
    soldCount: sold,
    remaining,
    soldOut,
    onSale: tierOnSale({ salesStartsAt: row.sales_starts_at, salesEndsAt: row.sales_ends_at }) && !soldOut,
  }
}

function tiersForEvent(eventId: string): TicketTier[] {
  const rows = db.prepare(
    `SELECT * FROM ticket_tiers WHERE event_id = ? ORDER BY sort_order ASC, name ASC`,
  ).all(eventId) as TierRow[]
  return rows.map(tierFromRow)
}

function getTierOrThrow(tierId: string): TierRow {
  const row = db.prepare(`SELECT * FROM ticket_tiers WHERE id = ?`).get(tierId) as TierRow | undefined
  if (!row)
    throw new HttpError(404, 'Tier not found')
  return row
}

function seatLabel(seatId: string | null): string | null {
  if (!seatId)
    return null
  const s = db.prepare(`SELECT label FROM seats WHERE id = ?`).get(seatId) as { label: string } | undefined
  return s?.label || null
}

function tierName(tierId: string | null): string | null {
  if (!tierId)
    return null
  const t = db.prepare(`SELECT name FROM ticket_tiers WHERE id = ?`).get(tierId) as { name: string } | undefined
  return t?.name || null
}

function ticketFromRow(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    buyerAddress: row.buyer_address,
    txHash: row.tx_hash,
    ticketSeed: row.ticket_seed,
    status: row.status,
    createdAt: row.created_at,
    redeemedAt: row.redeemed_at,
    cancelledAt: row.cancelled_at,
    tierId: row.tier_id,
    tierName: tierName(row.tier_id),
    seatId: row.seat_id,
    seatLabel: seatLabel(row.seat_id),
  }
}

function countsFor(eventId: string) {
  const sold = (db.prepare(
    `SELECT COUNT(*) AS c FROM tickets WHERE event_id = ? AND status != 'cancelled'`,
  ).get(eventId) as { c: number }).c
  const redeemed = (db.prepare(
    `SELECT COUNT(*) AS c FROM tickets WHERE event_id = ? AND status = 'redeemed'`,
  ).get(eventId) as { c: number }).c
  const waitlist = (db.prepare(
    `SELECT COUNT(*) AS c FROM waitlist WHERE event_id = ?`,
  ).get(eventId) as { c: number }).c
  return { sold, redeemed, waitlist }
}

function rowToEvent(row: EventRow): EventRecord {
  releaseExpiredHolds()
  const tiers = tiersForEvent(row.id)
  const { sold, redeemed, waitlist } = countsFor(row.id)

  let capacity: number | null = 0
  let remaining: number | null = 0
  let anyUnlimited = tiers.length === 0
  let allSoldOut = tiers.length > 0
  let minPrice = tiers.length ? Number.POSITIVE_INFINITY : row.price_luna

  for (const t of tiers) {
    minPrice = Math.min(minPrice, t.priceLuna)
    if (t.capacity == null) {
      anyUnlimited = true
      capacity = null
      remaining = null
    }
    else if (capacity != null) {
      capacity += t.capacity
      remaining = (remaining ?? 0) + (t.remaining ?? 0)
    }
    if (!t.soldOut)
      allSoldOut = false
  }

  if (tiers.length === 0) {
    capacity = row.capacity == null ? null : Number(row.capacity)
    remaining = capacity == null ? null : Math.max(0, capacity - sold)
    allSoldOut = capacity != null && sold >= capacity
  }

  if (anyUnlimited) {
    capacity = null
    remaining = null
    allSoldOut = false
  }

  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    coverUrl: row.cover_url,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    priceLuna: Number.isFinite(minPrice) ? minPrice : row.price_luna,
    capacity,
    venueName: row.venue_name,
    venueLat: row.venue_lat,
    venueLng: row.venue_lng,
    organizerAddress: row.organizer_address,
    createdAt: row.created_at,
    soldCount: sold,
    redeemedCount: redeemed,
    waitlistCount: waitlist,
    soldOut: allSoldOut,
    remaining,
    hasStaffPasscode: !!(row.staff_pass_hash && row.staff_pass_salt),
    hideSoldCount: !!row.hide_sold_count,
    hideRedeemedCount: !!row.hide_redeemed_count,
    hallSlotId: row.hall_slot_id || null,
    tiers,
  }
}

function getEventOrThrow(id: string): EventRow {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined
  if (!row)
    throw new HttpError(404, 'Event not found')
  return row
}

function requireUnlock(eventId: string, unlockToken: string): EventRow {
  const event = getEventOrThrow(eventId)
  if (event.unlock_token !== unlockToken)
    throw new HttpError(403, 'Invalid gate unlock token')
  return event
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export function listEvents() {
  releaseExpiredHolds()
  const rows = db.prepare('SELECT * FROM events ORDER BY created_at DESC').all() as EventRow[]
  return rows.map(rowToEvent)
}

export function getEvent(id: string) {
  return rowToEvent(getEventOrThrow(id))
}

export function getInventory(eventId: string, tierId?: string): InventorySnapshot {
  releaseExpiredHolds()
  getEventOrThrow(eventId)
  const tiers = tiersForEvent(eventId)
  const snap: InventorySnapshot = {
    eventId,
    syncedAt: new Date().toISOString(),
    tiers: tiers.map(t => ({
      id: t.id,
      soldCount: t.soldCount,
      remaining: t.remaining,
      soldOut: t.soldOut,
      onSale: t.onSale,
    })),
  }
  if (tierId) {
    const seats = db.prepare(
      `SELECT id, status, held_until FROM seats WHERE tier_id = ?`,
    ).all(tierId) as Array<{ id: string, status: string, held_until: string | null }>
    snap.seats = seats.map(s => ({
      id: s.id,
      status: s.status as SeatRecord['status'],
      heldUntil: s.held_until,
    }))
  }
  return snap
}

export function listSeats(eventId: string, tierId: string): SeatRecord[] {
  releaseExpiredHolds()
  getEventOrThrow(eventId)
  const tier = getTierOrThrow(tierId)
  if (tier.event_id !== eventId)
    throw new HttpError(400, 'Tier does not belong to event')
  const rows = db.prepare(
    `SELECT * FROM seats WHERE tier_id = ? ORDER BY row_key ASC, label ASC`,
  ).all(tierId) as SeatRow[]
  return rows.map(s => ({
    id: s.id,
    eventId: s.event_id,
    tierId: s.tier_id,
    label: s.label,
    rowKey: s.row_key,
    x: s.x,
    y: s.y,
    status: s.status,
    heldUntil: s.held_until,
  }))
}

function normalizeTierInput(body: CreateEventRequest): CreateTierInput[] {
  if (body.tiers?.length)
    return body.tiers
  const priceNim = body.priceNim ?? 0
  if (!(priceNim >= 0))
    throw new HttpError(400, 'priceNim must be >= 0')
  return [{
    name: 'General Admission',
    kind: 'ga',
    priceNim,
    capacity: body.capacity ?? null,
    perOrderMin: 1,
    perOrderMax: 10,
  }]
}

function insertSeatsForTier(eventId: string, tierId: string, template: SeatTemplateId) {
  let layout = generateSeatLayout(template)
  if (template === 'nimiq-hall')
    layout = layout.slice(0, NIMIQ_HALL_CAPACITY)
  const insert = db.prepare(`
    INSERT INTO seats (id, event_id, tier_id, label, row_key, x, y, status, held_until, held_by, hold_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'available', NULL, NULL, NULL)
  `)
  for (const s of layout)
    insert.run(nanoid(14), eventId, tierId, s.label, s.rowKey, s.x, s.y)
  return layout.length
}

export function createEvent(body: CreateEventRequest) {
  if (!body.title?.trim())
    throw new HttpError(400, 'title required')
  if (!body.organizerAddress?.trim())
    throw new HttpError(400, 'organizerAddress required')
  if (!body.startsAt || !body.endsAt)
    throw new HttpError(400, 'startsAt and endsAt required')

  const tierInputs = normalizeTierInput(body)
  for (const t of tierInputs) {
    if (!t.name?.trim())
      throw new HttpError(400, 'tier name required')
    if (!(t.priceNim >= 0))
      throw new HttpError(400, 'tier priceNim must be >= 0')
    if (t.capacity != null && (!(t.capacity > 0) || !Number.isFinite(t.capacity)))
      throw new HttpError(400, 'tier capacity must be a positive number or null')
    if (t.kind === 'reserved' && !t.mapTemplate)
      throw new HttpError(400, 'reserved tiers require mapTemplate')
    if (t.mapTemplate === 'nimiq-hall' && t.capacity != null && t.capacity > NIMIQ_HALL_CAPACITY)
      throw new HttpError(400, `Nimiq Hall capacity cannot exceed ${NIMIQ_HALL_CAPACITY}`)
  }

  if (body.hallSlotId) {
    const hallTiers = tierInputs.filter(t => t.kind === 'reserved' && t.mapTemplate === 'nimiq-hall')
    if (hallTiers.length !== 1 || tierInputs.length !== 1)
      throw new HttpError(400, 'Nimiq Hall events use a single reserved seat map')
    const seats = generateSeatLayout('nimiq-hall').length
    if (seats > NIMIQ_HALL_CAPACITY)
      throw new HttpError(500, `Nimiq Hall map exceeds ${NIMIQ_HALL_CAPACITY} seats`)
  }

  const id = nanoid(12)
  const master = generateMasterSecret()
  const unlockToken = nanoid(24)
  const now = new Date().toISOString()
  const staff = setStaffPassFields(body.staffPasscode)
  const staffPlain = body.staffPasscode ? normalizePasscode(body.staffPasscode) : null

  const minPrice = Math.min(...tierInputs.map(t => nimToLuna(t.priceNim)))
  let totalCap: number | null = 0
  for (const t of tierInputs) {
    if (t.kind === 'reserved' && t.mapTemplate) {
      // capacity set from generated seats
      continue
    }
    if (t.capacity == null) {
      totalCap = null
      break
    }
    totalCap += Math.floor(t.capacity)
  }

  const insertTier = db.prepare(`
    INSERT INTO ticket_tiers (
      id, event_id, name, kind, price_luna, capacity, per_order_min, per_order_max,
      sales_starts_at, sales_ends_at, map_template, map_section, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO events (
        id, title, description, cover_url, starts_at, ends_at, price_luna, capacity,
        venue_name, venue_lat, venue_lng, organizer_address, master_secret, unlock_token,
        staff_pass_salt, staff_pass_hash, hide_sold_count, hide_redeemed_count, hall_slot_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.title.trim(),
      (body.description || '').trim(),
      body.coverUrl?.trim() || null,
      body.startsAt,
      body.endsAt,
      minPrice,
      totalCap,
      body.venueName?.trim() || 'TBA',
      body.venueLat ?? null,
      body.venueLng ?? null,
      body.organizerAddress.trim(),
      master,
      unlockToken,
      staff.salt,
      staff.hash,
      body.hideSoldCount ? 1 : 0,
      body.hideRedeemedCount ? 1 : 0,
      body.hallSlotId || null,
      now,
    )

    let order = 0
    let reservedCapSum = 0
    let sawUnlimited = totalCap == null
    for (const t of tierInputs) {
      const tierId = nanoid(12)
      let cap = t.capacity == null ? null : Math.floor(t.capacity)
      let seatCount = 0
      if (t.kind === 'reserved' && t.mapTemplate) {
        seatCount = generateSeatLayout(t.mapTemplate).length
        if (t.mapTemplate === 'nimiq-hall')
          seatCount = Math.min(seatCount, NIMIQ_HALL_CAPACITY)
        cap = seatCount
        reservedCapSum += seatCount
      }
      else if (cap == null) {
        sawUnlimited = true
      }
      insertTier.run(
        tierId,
        id,
        t.name.trim(),
        t.kind,
        nimToLuna(t.priceNim),
        cap,
        Math.max(1, t.perOrderMin ?? 1),
        Math.max(1, t.perOrderMax ?? 10),
        t.salesStartsAt || null,
        t.salesEndsAt || null,
        t.mapTemplate || null,
        t.mapSection || null,
        order++,
      )
      if (t.kind === 'reserved' && t.mapTemplate)
        insertSeatsForTier(id, tierId, t.mapTemplate)
    }

    if (!sawUnlimited && reservedCapSum > 0) {
      const nonReserved = tierInputs
        .filter(t => t.kind !== 'reserved')
        .reduce((s, t) => s + (t.capacity == null ? 0 : Math.floor(t.capacity)), 0)
      db.prepare(`UPDATE events SET capacity = ? WHERE id = ?`).run(nonReserved + reservedCapSum, id)
    }
  })
  run()

  return {
    event: getEvent(id),
    eventMasterSecret: master,
    gateUnlockToken: unlockToken,
    staffPasscode: staffPlain,
  }
}

function expandItems(
  eventId: string,
  items: PurchaseItem[] | undefined,
  legacyQty: number,
): Array<{ tier: TierRow, quantity: number, seatIds: string[] }> {
  releaseExpiredHolds()
  const tiers = db.prepare(`SELECT * FROM ticket_tiers WHERE event_id = ?`).all(eventId) as TierRow[]
  if (!tiers.length)
    throw new HttpError(500, 'Event has no ticket tiers')

  if (!items?.length) {
    const ga = tiers.find(t => t.kind === 'ga') || tiers[0]!
    return [{ tier: ga, quantity: Math.max(1, Math.min(20, Math.floor(legacyQty || 1))), seatIds: [] }]
  }

  const out: Array<{ tier: TierRow, quantity: number, seatIds: string[] }> = []
  for (const item of items) {
    const tier = tiers.find(t => t.id === item.tierId)
    if (!tier)
      throw new HttpError(400, `Unknown tier ${item.tierId}`)
    if (tier.kind === 'reserved') {
      const seatIds = [...new Set(item.seatIds || [])]
      if (!seatIds.length)
        throw new HttpError(400, `Select seats for ${tier.name}`)
      out.push({ tier, quantity: seatIds.length, seatIds })
    }
    else {
      const qty = Math.max(1, Math.floor(item.quantity || 1))
      out.push({ tier, quantity: qty, seatIds: [] })
    }
  }
  return out
}

function validateCart(expanded: Array<{ tier: TierRow, quantity: number, seatIds: string[] }>) {
  let total = 0
  let priceLuna = 0
  for (const line of expanded) {
    if (!tierOnSale({ salesStartsAt: line.tier.sales_starts_at, salesEndsAt: line.tier.sales_ends_at }))
      throw new HttpError(400, `${line.tier.name} is not on sale`)
    if (line.quantity < line.tier.per_order_min)
      throw new HttpError(400, `${line.tier.name} requires at least ${line.tier.per_order_min}`)
    if (line.quantity > line.tier.per_order_max)
      throw new HttpError(400, `${line.tier.name} allows at most ${line.tier.per_order_max}`)
    total += line.quantity
    priceLuna += line.tier.price_luna * line.quantity
  }
  if (total < 1 || total > 20)
    throw new HttpError(400, 'Cart must be 1–20 tickets')
  return { total, priceLuna }
}

function holdOwnerKey(raw: string) {
  return raw.replace(/\s+/g, '').toUpperCase()
}

function seatHeldBy(seat: SeatRow, buyerKey: string) {
  if (!seat.held_by)
    return false
  return holdOwnerKey(seat.held_by) === holdOwnerKey(buyerKey)
}

function assertInventoryAvailable(
  expanded: Array<{ tier: TierRow, quantity: number, seatIds: string[] }>,
  holdId?: string,
  buyerKey?: string,
) {
  for (const line of expanded) {
    if (line.tier.kind === 'reserved') {
      for (const seatId of line.seatIds) {
        const seat = db.prepare(`SELECT * FROM seats WHERE id = ? AND tier_id = ?`).get(seatId, line.tier.id) as SeatRow | undefined
        if (!seat)
          throw new HttpError(400, `Seat ${seatId} not found`)
        if (seat.status === 'sold')
          throw new HttpError(409, `Seat ${seat.label} is taken`)
        if (seat.status === 'held') {
          const ours = (holdId && seat.hold_id === holdId)
            || (buyerKey && seatHeldBy(seat, buyerKey))
          const expired = seat.held_until && seat.held_until <= new Date().toISOString()
          if (!ours && !expired)
            throw new HttpError(409, `Seat ${seat.label} is held`)
        }
      }
    }
    else {
      const sold = tierSoldCount(line.tier.id)
      if (line.tier.capacity != null && sold + line.quantity > line.tier.capacity)
        throw new HttpError(409, `Not enough ${line.tier.name} tickets left`)
    }
  }
}

export function createHold(eventId: string, body: HoldRequest): HoldResponse {
  getEventOrThrow(eventId)
  if (!body.buyerKey?.trim())
    throw new HttpError(400, 'buyerKey required')
  const expanded = expandItems(eventId, body.items, 1)
  const { priceLuna } = validateCart(expanded)

  const holdId = nanoid(16)
  const now = Date.now()
  const expiresAt = new Date(now + HOLD_TTL_MS).toISOString()
  const createdAt = new Date(now).toISOString()
  const buyerKey = body.buyerKey.trim()
  const owner = holdOwnerKey(buyerKey)
  const priorHoldId = body.holdId?.trim() || ''

  const run = db.transaction(() => {
    releaseExpiredHolds()
    assertInventoryAvailable(expanded, priorHoldId || undefined, buyerKey)

    for (const line of expanded) {
      if (line.tier.kind !== 'reserved')
        continue
      for (const seatId of line.seatIds) {
        const res = db.prepare(`
          UPDATE seats SET status = 'held', held_until = ?, held_by = ?, hold_id = ?
          WHERE id = ? AND tier_id = ?
            AND (
              status = 'available'
              OR (status = 'held' AND REPLACE(UPPER(held_by), ' ', '') = ?)
              OR (status = 'held' AND ? != '' AND hold_id = ?)
            )
        `).run(expiresAt, owner, holdId, seatId, line.tier.id, owner, priorHoldId, priorHoldId)
        if (res.changes !== 1)
          throw new HttpError(409, 'Seat no longer available')
      }
    }

    const stale = db.prepare(
      `SELECT id FROM holds WHERE event_id = ? AND REPLACE(UPPER(buyer_key), ' ', '') = ? AND id != ?`,
    ).all(eventId, owner, holdId) as Array<{ id: string }>
    for (const old of stale) {
      db.prepare(`
        UPDATE seats SET status = 'available', held_until = NULL, held_by = NULL, hold_id = NULL
        WHERE hold_id = ? AND status = 'held'
      `).run(old.id)
      db.prepare(`DELETE FROM holds WHERE id = ?`).run(old.id)
    }

    db.prepare(`
      INSERT INTO holds (id, event_id, buyer_key, payload, price_luna, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(holdId, eventId, owner, JSON.stringify(body.items), priceLuna, expiresAt, createdAt)
  })
  run()

  return {
    holdId,
    expiresAt,
    priceLuna,
    items: body.items,
  }
}

function ticketsForPayment(baseHash: string): TicketRow[] {
  return db.prepare(
    `SELECT * FROM tickets WHERE tx_hash = ? OR tx_hash LIKE ? ORDER BY created_at ASC`,
  ).all(baseHash, `${baseHash}#%`) as TicketRow[]
}

export async function purchaseTicket(
  eventId: string,
  txHash: string,
  buyerAddress: string,
  demo?: boolean,
  quantity = 1,
  items?: PurchaseItem[],
  holdId?: string,
) {
  const event = getEventOrThrow(eventId)
  const cleanHash = txHash.trim()

  const existing = ticketsForPayment(cleanHash)
  if (existing.length) {
    const tickets = existing.map(ticketFromRow)
    return { tickets, ticket: tickets[0]! }
  }

  let cartItems = items
  if (holdId) {
    const hold = db.prepare(`SELECT * FROM holds WHERE id = ? AND event_id = ?`).get(holdId, eventId) as HoldRow | undefined
    if (!hold)
      throw new HttpError(400, 'Hold expired or not found')
    if (hold.expires_at < new Date().toISOString()) {
      releaseExpiredHolds()
      throw new HttpError(409, 'Hold expired — select again')
    }
    cartItems = JSON.parse(hold.payload) as PurchaseItem[]
  }

  const expanded = expandItems(eventId, cartItems, quantity)
  const { total, priceLuna: needLuna } = validateCart(expanded)
  const memo = paymentMemo(eventId, total)

  let resolvedBuyer = buyerAddress.trim()
  const skip = allowSkipVerify() && demo === true

  if (!skip) {
    if (!cleanHash || cleanHash.startsWith('demo-'))
      throw new HttpError(400, 'Valid on-chain txHash required')

    let tx
    try {
      tx = await waitForTransaction(cleanHash)
    }
    catch (err) {
      throw new HttpError(408, err instanceof Error ? err.message : 'Timed out waiting for payment')
    }

    try {
      assertPaymentMatches({
        tx,
        organizerAddress: event.organizer_address,
        buyerAddress: resolvedBuyer,
        priceLuna: needLuna,
        memo,
      })
    }
    catch (err) {
      if (total > 1 && err instanceof Error && /memo/i.test(err.message)) {
        try {
          assertPaymentMatches({
            tx,
            organizerAddress: event.organizer_address,
            buyerAddress: resolvedBuyer,
            priceLuna: needLuna,
            memo: paymentMemo(eventId, 1),
          })
        }
        catch (err2) {
          throw new HttpError(400, err2 instanceof Error ? err2.message : 'Payment verification failed')
        }
      }
      else {
        throw new HttpError(400, err instanceof Error ? err.message : 'Payment verification failed')
      }
    }

    if (tx.sender)
      resolvedBuyer = tx.sender
  }

  // Precompute seeds outside the write txn (async)
  const planned: Array<{
    id: string
    tierId: string
    seatId: string | null
    txHash: string
    seed: string
  }> = []
  let idx = 0
  for (const line of expanded) {
    if (line.tier.kind === 'reserved') {
      for (const seatId of line.seatIds) {
        const ticketId = nanoid(16)
        planned.push({
          id: ticketId,
          tierId: line.tier.id,
          seatId,
          txHash: total === 1 ? cleanHash : `${cleanHash}#${idx++}`,
          seed: await deriveTicketSeed(event.master_secret, ticketId),
        })
      }
    }
    else {
      for (let i = 0; i < line.quantity; i++) {
        const ticketId = nanoid(16)
        planned.push({
          id: ticketId,
          tierId: line.tier.id,
          seatId: null,
          txHash: total === 1 ? cleanHash : `${cleanHash}#${idx++}`,
          seed: await deriveTicketSeed(event.master_secret, ticketId),
        })
      }
    }
  }

  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT INTO tickets (
      id, event_id, buyer_address, tx_hash, ticket_seed, status, created_at, redeemed_at, cancelled_at, tier_id, seat_id
    ) VALUES (?, ?, ?, ?, ?, 'valid', ?, NULL, NULL, ?, ?)
  `)

  const commit = db.transaction(() => {
    releaseExpiredHolds()
    assertInventoryAvailable(expanded, holdId, resolvedBuyer)

    for (const line of expanded) {
      if (line.tier.kind === 'reserved') {
        for (const seatId of line.seatIds) {
          const seat = db.prepare(`SELECT * FROM seats WHERE id = ?`).get(seatId) as SeatRow
          const ours = seat.status === 'held' && (
            (holdId && seat.hold_id === holdId) || seatHeldBy(seat, resolvedBuyer)
          )
          if (ours) {
            db.prepare(`UPDATE seats SET status = 'sold', held_until = NULL, held_by = NULL, hold_id = NULL WHERE id = ?`).run(seatId)
          }
          else {
            const res = db.prepare(`
              UPDATE seats SET status = 'sold', held_until = NULL, held_by = NULL, hold_id = NULL
              WHERE id = ? AND status = 'available'
            `).run(seatId)
            if (res.changes !== 1)
              throw new HttpError(409, `Seat ${seat.label} no longer available`)
          }
        }
      }
      else {
        const sold = tierSoldCount(line.tier.id)
        if (line.tier.capacity != null && sold + line.quantity > line.tier.capacity)
          throw new HttpError(409, `Not enough ${line.tier.name} tickets left`)
      }
    }

    for (const p of planned)
      insert.run(p.id, eventId, resolvedBuyer, p.txHash, p.seed, now, p.tierId, p.seatId)

    if (holdId) {
      db.prepare(`DELETE FROM holds WHERE id = ?`).run(holdId)
      db.prepare(`
        UPDATE seats SET status = 'available', held_until = NULL, held_by = NULL, hold_id = NULL
        WHERE hold_id = ? AND status = 'held'
      `).run(holdId)
    }

    db.prepare(`DELETE FROM waitlist WHERE event_id = ? AND address = ?`).run(eventId, resolvedBuyer)
  })

  try {
    commit()
  }
  catch (err) {
    if (err instanceof HttpError)
      throw err
    throw err
  }

  const tickets = planned.map(p => getTicket(p.id))
  return { tickets, ticket: tickets[0]! }
}

export function getTicket(ticketId: string) {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as TicketRow | undefined
  if (!row)
    throw new HttpError(404, 'Ticket not found')
  return ticketFromRow(row)
}

export async function redeemTicket(ticketId: string, totp: string) {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as TicketRow | undefined
  if (!row)
    throw new HttpError(404, 'Ticket not found')
  if (row.status === 'cancelled')
    throw new HttpError(409, 'Ticket cancelled / refunded')
  if (row.status === 'redeemed')
    throw new HttpError(409, 'Ticket already redeemed')

  const ok = await verifyTotp(row.ticket_seed, totp)
  if (!ok)
    throw new HttpError(401, 'Invalid or expired TOTP code')

  const now = new Date().toISOString()
  db.prepare('UPDATE tickets SET status = ?, redeemed_at = ? WHERE id = ?').run('redeemed', now, ticketId)
  return { ok: true, ticketId, redeemedAt: now }
}

export function cancelTicket(ticketId: string, unlockToken: string) {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as TicketRow | undefined
  if (!row)
    throw new HttpError(404, 'Ticket not found')
  requireUnlock(row.event_id, unlockToken)
  if (row.status === 'cancelled')
    return ticketFromRow(row)
  if (row.status === 'redeemed')
    throw new HttpError(409, 'Cannot cancel a redeemed ticket')

  const now = new Date().toISOString()
  const run = db.transaction(() => {
    db.prepare(`UPDATE tickets SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(now, ticketId)
    if (row.seat_id) {
      db.prepare(`
        UPDATE seats SET status = 'available', held_until = NULL, held_by = NULL, hold_id = NULL WHERE id = ?
      `).run(row.seat_id)
    }
  })
  run()
  return getTicket(ticketId)
}

export async function transferTicket(ticketId: string, toAddress: string, fromAddress?: string) {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as TicketRow | undefined
  if (!row)
    throw new HttpError(404, 'Ticket not found')
  if (row.status !== 'valid')
    throw new HttpError(409, `Cannot transfer ticket in status ${row.status}`)
  if (!fromAddress?.trim())
    throw new HttpError(400, 'fromAddress required')
  if (!addressesEqual(fromAddress, row.buyer_address))
    throw new HttpError(403, 'fromAddress does not own this ticket')
  if (!toAddress?.trim() || !isNqAddress(toAddress))
    throw new HttpError(400, 'Valid toAddress required')
  if (addressesEqual(toAddress, row.buyer_address))
    throw new HttpError(400, 'Cannot transfer a ticket to yourself')

  const event = getEventOrThrow(row.event_id)
  const now = new Date().toISOString()
  const newId = nanoid(16)
  const transferId = nanoid(16)
  const seed = await deriveTicketSeed(event.master_secret, newId)
  const newHash = `transfer:${row.id}:${newId}`
  const recipient = toAddress.trim()

  const run = db.transaction(() => {
    db.prepare(`UPDATE tickets SET status = 'cancelled', cancelled_at = ?, seat_id = NULL WHERE id = ?`).run(now, ticketId)
    db.prepare(`
      INSERT INTO tickets (
        id, event_id, buyer_address, tx_hash, ticket_seed, status, created_at, redeemed_at, cancelled_at, tier_id, seat_id
      ) VALUES (?, ?, ?, ?, ?, 'valid', ?, NULL, NULL, ?, ?)
    `).run(newId, row.event_id, recipient, newHash, seed, now, row.tier_id, row.seat_id)
    db.prepare(`
      INSERT INTO ticket_transfers (
        id, from_address, to_address, from_ticket_id, to_ticket_id, event_id, tier_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(transferId, row.buyer_address, recipient, ticketId, newId, row.event_id, row.tier_id, now)
  })
  run()

  const issued = getTicket(newId)
  return {
    cancelledTicketId: ticketId,
    transfer: {
      toTicketId: issued.id,
      toAddress: issued.buyerAddress,
      fromAddress: row.buyer_address,
      fromTicketId: ticketId,
      eventId: event.id,
      eventTitle: event.title,
      tierId: issued.tierId,
      tierName: issued.tierName,
      seatLabel: issued.seatLabel,
      createdAt: now,
    },
  }
}

function buildGateBundle(event: EventRow) {
  const tickets = db.prepare('SELECT id, ticket_seed, status FROM tickets WHERE event_id = ?').all(event.id) as Array<{
    id: string
    ticket_seed: string
    status: TicketStatus
  }>

  return {
    eventId: event.id,
    eventTitle: event.title,
    endsAt: event.ends_at,
    eventMasterSecret: event.master_secret,
    syncedAt: new Date().toISOString(),
    tickets: tickets.map(t => ({
      id: t.id,
      ticketSeed: t.ticket_seed,
      status: t.status,
    })),
  }
}

export function getGateBundle(eventId: string, unlockToken: string) {
  const event = requireUnlock(eventId, unlockToken)
  return buildGateBundle(event)
}

export function staffUnlock(eventId: string, passcode: string) {
  const event = getEventOrThrow(eventId)
  verifyStaffPass(event, passcode)
  return {
    eventId: event.id,
    gateUnlockToken: event.unlock_token,
    eventMasterSecret: event.master_secret,
    bundle: buildGateBundle(event),
  }
}

/** Organizer wallet session — same payload as staff PIN unlock. */
export function hostUnlock(eventId: string, organizerAddress: string) {
  const event = getEventOrThrow(eventId)
  if (!addressesEqual(event.organizer_address, organizerAddress))
    throw new HttpError(403, 'Not the host of this event')
  return {
    eventId: event.id,
    gateUnlockToken: event.unlock_token,
    eventMasterSecret: event.master_secret,
    bundle: buildGateBundle(event),
  }
}

export function setStaffPasscode(eventId: string, unlockToken: string, passcode: string | null) {
  requireUnlock(eventId, unlockToken)
  const staff = setStaffPassFields(passcode)
  db.prepare(
    `UPDATE events SET staff_pass_salt = ?, staff_pass_hash = ? WHERE id = ?`,
  ).run(staff.salt, staff.hash, eventId)
  return {
    ok: true,
    hasStaffPasscode: !!(staff.hash && staff.salt),
    staffPasscode: passcode ? normalizePasscode(passcode) : null,
  }
}

export function listGuests(eventId: string, unlockToken: string): GuestRow[] {
  requireUnlock(eventId, unlockToken)
  const rows = db.prepare(
    `SELECT * FROM tickets WHERE event_id = ? ORDER BY created_at ASC`,
  ).all(eventId) as TicketRow[]
  return rows.map(r => ({
    ticketId: r.id,
    buyerAddress: r.buyer_address,
    status: r.status,
    txHash: r.tx_hash,
    createdAt: r.created_at,
    redeemedAt: r.redeemed_at,
    cancelledAt: r.cancelled_at,
    tierName: tierName(r.tier_id),
    seatLabel: seatLabel(r.seat_id),
  }))
}

export function joinWaitlist(eventId: string, address: string): WaitlistEntry {
  getEventOrThrow(eventId)
  const ev = getEvent(eventId)
  if (!ev.soldOut)
    throw new HttpError(400, 'Event is not sold out — buy a ticket instead')
  if (!address?.trim())
    throw new HttpError(400, 'address required')

  const id = nanoid(12)
  const now = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO waitlist (id, event_id, address, created_at) VALUES (?, ?, ?, ?)`,
    ).run(id, eventId, address.trim(), now)
  }
  catch {
    const existing = db.prepare(
      `SELECT * FROM waitlist WHERE event_id = ? AND address = ?`,
    ).get(eventId, address.trim()) as WaitlistRow
    return { id: existing.id, eventId, address: existing.address, createdAt: existing.created_at }
  }
  return { id, eventId, address: address.trim(), createdAt: now }
}

export function listWaitlist(eventId: string, unlockToken: string): WaitlistEntry[] {
  requireUnlock(eventId, unlockToken)
  const rows = db.prepare(
    `SELECT * FROM waitlist WHERE event_id = ? ORDER BY created_at ASC`,
  ).all(eventId) as WaitlistRow[]
  return rows.map(r => ({
    id: r.id,
    eventId: r.event_id,
    address: r.address,
    createdAt: r.created_at,
  }))
}

export function handleError(err: unknown, c: Context) {
  if (err instanceof HttpError)
    return c.json({ error: err.message }, err.status as 400)
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
}
