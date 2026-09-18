import { isNqAddress, normalizeNqAddress } from '@gatepass/shared'
import { newId } from '@/lib/id'

const KEY = 'gatepass:contacts'

export interface Contact {
  id: string
  name: string
  address: string
  createdAt: string
}

function read(): Contact[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw)
      return []
    const list = JSON.parse(raw) as Contact[]
    return Array.isArray(list) ? list : []
  }
  catch {
    return []
  }
}

function write(list: Contact[]) {
  localStorage.setItem(KEY, JSON.stringify(list))
}

export function listContacts(): Contact[] {
  return read().sort((a, b) => a.name.localeCompare(b.name))
}

export function upsertContact(input: { id?: string, name: string, address: string }): Contact {
  const name = input.name.trim()
  const address = input.address.trim()
  if (!name)
    throw new Error('Name required')
  if (!isNqAddress(address))
    throw new Error('Enter a valid NQ address')
  const list = read()
  const id = input.id || newId()
  const existing = list.findIndex(c => c.id === id)
  const row: Contact = {
    id,
    name,
    address: normalizeNqAddress(address).replace(/(.{4})/g, '$1 ').trim(),
    createdAt: existing >= 0 ? list[existing]!.createdAt : new Date().toISOString(),
  }
  const next = existing >= 0
    ? list.map(c => (c.id === id ? row : c))
    : [...list, row]
  write(next)
  return row
}

export function removeContact(id: string) {
  write(read().filter(c => c.id !== id))
}

export function findContactByAddress(address: string): Contact | undefined {
  const n = normalizeNqAddress(address)
  return read().find(c => normalizeNqAddress(c.address) === n)
}
