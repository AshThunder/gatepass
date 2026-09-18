import type { HallInfo, HallSlot, RentHallRequest, RentHallResponse } from '@gatepass/shared'
import { hallRentMemo } from '@gatepass/shared'
import { db, type HallSlotRow, seedHallSlots } from './db.js'
import {
  allowSkipVerify,
  assertPaymentMatches,
  waitForTransaction,
} from './nimiq-rpc.js'
import { createEvent, HttpError } from './routes/events.js'
import { NIMIQ_HALL_CAPACITY, generateSeatLayout } from './seat-templates.js'

function hallName() {
  return process.env.HALL_NAME?.trim() || 'Nimiq Hall'
}

function hallRentNim() {
  const n = Number(process.env.HALL_RENT_NIM ?? '5')
  return Number.isFinite(n) && n >= 0 ? n : 5
}

function platformAddress() {
  const a = process.env.HALL_PLATFORM_ADDRESS?.trim()
  return a || null
}

function rowToSlot(row: HallSlotRow): HallSlot {
  return {
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    rentLuna: row.rent_luna,
    status: row.status as HallSlot['status'],
    eventId: row.event_id,
    renterAddress: row.renter_address,
  }
}

export function getHallInfo(): HallInfo {
  seedHallSlots()
  const rows = db.prepare(`
    SELECT * FROM hall_slots
    WHERE starts_at > datetime('now', '-6 hours')
    ORDER BY starts_at ASC
    LIMIT 24
  `).all() as HallSlotRow[]

  return {
    name: hallName(),
    venueName: hallName(),
    description: `Platform venue with ${NIMIQ_HALL_CAPACITY} labeled seats. Rent a night, sell tickets, scan at the door.`,
    mapTemplate: 'nimiq-hall',
    platformAddress: platformAddress(),
    rentNim: hallRentNim(),
    capacity: NIMIQ_HALL_CAPACITY,
    previewSeats: generateSeatLayout('nimiq-hall').map(s => ({
      label: s.label,
      rowKey: s.rowKey,
      x: s.x,
      y: s.y,
    })),
    slots: rows.map(rowToSlot),
  }
}

export async function rentHallSlot(slotId: string, body: RentHallRequest): Promise<RentHallResponse> {
  seedHallSlots()
  const slot = db.prepare('SELECT * FROM hall_slots WHERE id = ?').get(slotId) as HallSlotRow | undefined
  if (!slot)
    throw new HttpError(404, 'Hall slot not found')
  if (slot.status !== 'open')
    throw new HttpError(409, 'Hall slot is not available')
  if (!body.organizerAddress?.trim())
    throw new HttpError(400, 'organizerAddress required')
  if (!body.title?.trim())
    throw new HttpError(400, 'title required')
  if (!body.txHash?.trim())
    throw new HttpError(400, 'txHash required')

  const platform = platformAddress()
  const rentLuna = slot.rent_luna
  const memo = hallRentMemo(slotId)
  const skip = allowSkipVerify() && body.demo === true
  const cleanHash = body.txHash.trim()

  if (!skip) {
    if (!platform)
      throw new HttpError(503, 'HALL_PLATFORM_ADDRESS not configured')
    if (cleanHash.startsWith('demo-'))
      throw new HttpError(400, 'Valid on-chain txHash required')
    let tx
    try {
      tx = await waitForTransaction(cleanHash)
    }
    catch (err) {
      throw new HttpError(408, err instanceof Error ? err.message : 'Timed out waiting for rent payment')
    }
    try {
      assertPaymentMatches({
        tx,
        organizerAddress: platform,
        buyerAddress: body.organizerAddress.trim(),
        priceLuna: rentLuna,
        memo,
      })
    }
    catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'Rent payment invalid')
    }
  }

  const ticketPrice = body.ticketPriceNim ?? 1
  const staffPin = String(Math.floor(100000 + Math.random() * 900000))

  const created = createEvent({
    title: body.title.trim(),
    description: body.description?.trim() || `Live at ${hallName()}`,
    venueName: hallName(),
    startsAt: slot.starts_at,
    endsAt: slot.ends_at,
    organizerAddress: body.organizerAddress.trim(),
    staffPasscode: staffPin,
    hideSoldCount: body.hideSoldCount,
    hideRedeemedCount: body.hideRedeemedCount,
    hallSlotId: slotId,
    capacity: NIMIQ_HALL_CAPACITY,
    tiers: [{
      name: 'Reserved seat',
      kind: 'reserved',
      priceNim: ticketPrice,
      capacity: NIMIQ_HALL_CAPACITY,
      perOrderMin: 1,
      perOrderMax: 8,
      mapTemplate: 'nimiq-hall',
    }],
  })

  const updated = db.prepare(`
    UPDATE hall_slots
    SET status = 'booked', event_id = ?, renter_address = ?, rent_tx_hash = ?
    WHERE id = ? AND status = 'open'
  `).run(
    created.event.id,
    body.organizerAddress.trim(),
    cleanHash,
    slotId,
  )
  if (updated.changes === 0)
    throw new HttpError(409, 'Hall slot was booked by someone else')

  const booked = db.prepare('SELECT * FROM hall_slots WHERE id = ?').get(slotId) as HallSlotRow

  return {
    slot: rowToSlot(booked),
    event: created.event,
    eventMasterSecret: created.eventMasterSecret,
    gateUnlockToken: created.gateUnlockToken,
    staffPasscode: created.staffPasscode || staffPin,
  }
}
