/** Recover tickets after pay if claim failed mid-flow. */
import { api } from '@/api/client'
import type { EventRecord, PurchaseItem, TicketRecord } from '@gatepass/shared'

const PENDING_KEY = 'gatepass:pendingTx'

export interface PendingTx {
  eventId: string
  txHash: string
  buyerAddress: string
  quantity?: number
  items?: PurchaseItem[]
  holdId?: string
  at: number
}

export function readPendingTx(): PendingTx | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw)
      return null
    return JSON.parse(raw) as PendingTx
  }
  catch {
    return null
  }
}

export function clearPendingTx() {
  localStorage.removeItem(PENDING_KEY)
}

function persistTickets(tickets: TicketRecord[], ev: EventRecord) {
  const raw = localStorage.getItem('gatepass:myTickets')
  let list: Array<{ ticket: TicketRecord, event: EventRecord }> = []
  try {
    list = raw ? JSON.parse(raw) as typeof list : []
  }
  catch { list = [] }
  for (const t of tickets) {
    list = list.filter(x => x.ticket.id !== t.id)
    list.unshift({ ticket: t, event: ev })
  }
  localStorage.setItem('gatepass:myTickets', JSON.stringify(list.slice(0, 40)))
  if (tickets[0])
    localStorage.setItem('gatepass:myTicket', JSON.stringify({ ticket: tickets[0], event: ev }))
}

export async function claimPendingTx(): Promise<{
  ok: boolean
  tickets?: TicketRecord[]
  event?: EventRecord
  error?: string
}> {
  const pending = readPendingTx()
  if (!pending?.txHash || !pending.eventId)
    return { ok: false }

  try {
    const { event } = await api.getEvent(pending.eventId)
    const res = await api.purchase(pending.eventId, {
      txHash: pending.txHash,
      buyerAddress: pending.buyerAddress || 'NQ07 UNKNOWN',
      quantity: pending.quantity ?? 1,
      items: pending.items,
      holdId: pending.holdId,
      demo: false,
    })
    const tickets = res.tickets?.length ? res.tickets : [res.ticket]
    persistTickets(tickets, event)
    clearPendingTx()
    localStorage.setItem('gatepass:pendingOpenEvent', event.id)
    return { ok: true, tickets, event }
  }
  catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
