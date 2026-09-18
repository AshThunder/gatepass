import {
  addressesEqual,
  type InboxTicket,
  type OutboxTransfer,
  type TicketTransferMeta,
} from '@gatepass/shared'
import { db } from '../db.js'
import { getEvent, getTicket } from './events.js'

function compactAddress(addr: string) {
  return addr.replace(/\s+/g, '').toUpperCase()
}

export function listInbox(address: string): InboxTicket[] {
  const key = compactAddress(address)
  const rows = db.prepare(`
    SELECT id FROM tickets
    WHERE REPLACE(UPPER(buyer_address), ' ', '') = ?
      AND status = 'valid'
    ORDER BY created_at DESC
  `).all(key) as Array<{ id: string }>

  return rows.map((row) => {
    const ticket = getTicket(row.id)
    return { ticket, event: getEvent(ticket.eventId) }
  })
}

export function listOutbox(address: string): OutboxTransfer[] {
  const key = compactAddress(address)
  const rows = db.prepare(`
    SELECT * FROM ticket_transfers
    WHERE REPLACE(UPPER(from_address), ' ', '') = ?
    ORDER BY created_at DESC
  `).all(key) as Array<{
    from_address: string
    to_address: string
    from_ticket_id: string
    to_ticket_id: string
    event_id: string
    tier_id: string | null
    created_at: string
  }>

  return rows.map((row) => {
    const event = getEvent(row.event_id)
    let tierName: string | null = null
    let seatLabel: string | null = null
    try {
      const ticket = getTicket(row.to_ticket_id)
      tierName = ticket.tierName
      seatLabel = ticket.seatLabel
    }
    catch {
      // ticket may have been cancelled later
    }
    const meta: TicketTransferMeta = {
      toTicketId: row.to_ticket_id,
      toAddress: row.to_address,
      fromAddress: row.from_address,
      fromTicketId: row.from_ticket_id,
      eventId: row.event_id,
      eventTitle: event.title,
      tierId: row.tier_id,
      tierName,
      seatLabel,
      createdAt: row.created_at,
    }
    return meta
  }).filter(row => addressesEqual(row.fromAddress, address) || compactAddress(row.fromAddress) === key)
}
