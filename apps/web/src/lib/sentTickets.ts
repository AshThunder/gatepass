import type { TicketTransferMeta } from '@gatepass/shared'

const KEY = 'gatepass:sentTickets'

export interface SentRow {
  transfer: TicketTransferMeta
  contactName: string | null
}

function read(): SentRow[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw)
      return []
    const list = JSON.parse(raw) as SentRow[]
    return Array.isArray(list) ? list : []
  }
  catch {
    return []
  }
}

function write(list: SentRow[]) {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 80)))
}

export function listSent(): SentRow[] {
  return read()
}

export function appendSent(row: SentRow) {
  const next = read().filter(s => s.transfer.toTicketId !== row.transfer.toTicketId)
  next.unshift(row)
  write(next)
}

export function mergeOutbox(rows: SentRow[]) {
  const byId = new Map(read().map(s => [s.transfer.toTicketId, s]))
  for (const row of rows) {
    const prev = byId.get(row.transfer.toTicketId)
    byId.set(row.transfer.toTicketId, {
      transfer: row.transfer,
      contactName: prev?.contactName || row.contactName,
    })
  }
  write([...byId.values()].sort(
    (a, b) => +new Date(b.transfer.createdAt) - +new Date(a.transfer.createdAt),
  ))
}
