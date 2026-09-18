import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import type { SeatStatus, TicketStatus, TierKind, SeatTemplateId } from '@gatepass/shared'

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'gatepass.db')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    cover_url TEXT,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    price_luna INTEGER NOT NULL,
    capacity INTEGER,
    venue_name TEXT NOT NULL,
    venue_lat REAL,
    venue_lng REAL,
    organizer_address TEXT NOT NULL,
    master_secret TEXT NOT NULL,
    unlock_token TEXT NOT NULL,
    staff_pass_salt TEXT,
    staff_pass_hash TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    buyer_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    ticket_seed TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('valid', 'redeemed', 'cancelled')),
    created_at TEXT NOT NULL,
    redeemed_at TEXT,
    cancelled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(event_id, address)
  );

  CREATE TABLE IF NOT EXISTS ticket_tiers (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    price_luna INTEGER NOT NULL,
    capacity INTEGER,
    per_order_min INTEGER NOT NULL DEFAULT 1,
    per_order_max INTEGER NOT NULL DEFAULT 10,
    sales_starts_at TEXT,
    sales_ends_at TEXT,
    map_template TEXT,
    map_section TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS seats (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    tier_id TEXT NOT NULL REFERENCES ticket_tiers(id),
    label TEXT NOT NULL,
    row_key TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('available', 'held', 'sold')),
    held_until TEXT,
    held_by TEXT,
    hold_id TEXT
  );

  CREATE TABLE IF NOT EXISTS holds (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    buyer_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    price_luna INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
  CREATE INDEX IF NOT EXISTS idx_waitlist_event ON waitlist(event_id);
  CREATE INDEX IF NOT EXISTS idx_tiers_event ON ticket_tiers(event_id);
  CREATE INDEX IF NOT EXISTS idx_seats_tier ON seats(tier_id);
  CREATE INDEX IF NOT EXISTS idx_seats_event ON seats(event_id);
  CREATE INDEX IF NOT EXISTS idx_holds_event ON holds(event_id);
`)

function ensureColumn(table: string, column: string, ddl: string) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name)
  if (!cols.includes(column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

ensureColumn('events', 'description', `description TEXT NOT NULL DEFAULT ''`)
ensureColumn('events', 'cover_url', `cover_url TEXT`)
ensureColumn('events', 'capacity', `capacity INTEGER`)
ensureColumn('events', 'staff_pass_salt', `staff_pass_salt TEXT`)
ensureColumn('events', 'staff_pass_hash', `staff_pass_hash TEXT`)
ensureColumn('events', 'hide_sold_count', `hide_sold_count INTEGER NOT NULL DEFAULT 0`)
ensureColumn('events', 'hide_redeemed_count', `hide_redeemed_count INTEGER NOT NULL DEFAULT 0`)
ensureColumn('events', 'hall_slot_id', `hall_slot_id TEXT`)
ensureColumn('tickets', 'cancelled_at', `cancelled_at TEXT`)
ensureColumn('tickets', 'tier_id', `tier_id TEXT`)
ensureColumn('tickets', 'seat_id', `seat_id TEXT`)

db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_transfers (
    id TEXT PRIMARY KEY,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    from_ticket_id TEXT NOT NULL,
    to_ticket_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    tier_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_transfers_from ON ticket_transfers(from_address);
  CREATE INDEX IF NOT EXISTS idx_transfers_to ON ticket_transfers(to_address);
  CREATE INDEX IF NOT EXISTS idx_tickets_buyer ON tickets(buyer_address);

  CREATE TABLE IF NOT EXISTS auth_challenges (
    nonce TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS hall_slots (
    id TEXT PRIMARY KEY,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    rent_luna INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open', 'held', 'booked')),
    event_id TEXT,
    renter_address TEXT,
    rent_tx_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hall_slots_starts ON hall_slots(starts_at);
`)

/** Seed upcoming open hall evenings if none exist in the future. */
export function seedHallSlots() {
  const rentNim = Number(process.env.HALL_RENT_NIM ?? '5')
  const rentLuna = Math.round((Number.isFinite(rentNim) ? rentNim : 5) * 100_000)
  const future = db.prepare(`
    SELECT COUNT(*) AS c FROM hall_slots
    WHERE starts_at > datetime('now') AND status = 'open'
  `).get() as { c: number }
  if (future.c >= 2)
    return

  const insert = db.prepare(`
    INSERT OR IGNORE INTO hall_slots (id, starts_at, ends_at, rent_luna, status, event_id, renter_address, rent_tx_hash)
    VALUES (?, ?, ?, ?, 'open', NULL, NULL, NULL)
  `)
  const now = new Date()
  for (let i = 1; i <= 6; i++) {
    const day = new Date(now)
    day.setDate(day.getDate() + i)
    day.setHours(18, 0, 0, 0)
    const end = new Date(day)
    end.setHours(23, 0, 0, 0)
    const id = `hall-${day.toISOString().slice(0, 10)}`
    insert.run(id, day.toISOString(), end.toISOString(), rentLuna)
  }
}

seedHallSlots()


// If legacy CHECK prevents cancelled status, rebuild tickets table
const ticketSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'`).get() as { sql?: string } | undefined)?.sql || ''
if (ticketSql.includes(`'valid', 'redeemed'`) && !ticketSql.includes('cancelled')) {
  db.exec(`
    CREATE TABLE tickets_new (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      buyer_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE,
      ticket_seed TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('valid', 'redeemed', 'cancelled')),
      created_at TEXT NOT NULL,
      redeemed_at TEXT,
      cancelled_at TEXT,
      tier_id TEXT,
      seat_id TEXT
    );
    INSERT INTO tickets_new (id, event_id, buyer_address, tx_hash, ticket_seed, status, created_at, redeemed_at, cancelled_at, tier_id, seat_id)
      SELECT id, event_id, buyer_address, tx_hash, ticket_seed, status, created_at, redeemed_at,
        CASE WHEN cancelled_at IS NOT NULL THEN cancelled_at ELSE NULL END,
        NULL, NULL
      FROM tickets;
    DROP TABLE tickets;
    ALTER TABLE tickets_new RENAME TO tickets;
    CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
  `)
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_seat_unique ON tickets(seat_id) WHERE seat_id IS NOT NULL`)

/** Backfill a GA tier for legacy events that have none. */
export function backfillGaTiers() {
  const events = db.prepare('SELECT id, price_luna, capacity FROM events').all() as Array<{
    id: string
    price_luna: number
    capacity: number | null
  }>
  const hasTier = db.prepare('SELECT COUNT(*) AS c FROM ticket_tiers WHERE event_id = ?')
  const insert = db.prepare(`
    INSERT INTO ticket_tiers (
      id, event_id, name, kind, price_luna, capacity, per_order_min, per_order_max,
      sales_starts_at, sales_ends_at, map_template, map_section, sort_order
    ) VALUES (?, ?, 'General Admission', 'ga', ?, ?, 1, 10, NULL, NULL, NULL, NULL, 0)
  `)
  const link = db.prepare(`UPDATE tickets SET tier_id = ? WHERE event_id = ? AND tier_id IS NULL`)

  for (const ev of events) {
    const c = (hasTier.get(ev.id) as { c: number }).c
    if (c > 0)
      continue
    const tierId = nanoid(12)
    insert.run(tierId, ev.id, ev.price_luna, ev.capacity)
    link.run(tierId, ev.id)
  }
}

backfillGaTiers()

export interface EventRow {
  id: string
  title: string
  description: string
  cover_url: string | null
  starts_at: string
  ends_at: string
  price_luna: number
  capacity: number | null
  venue_name: string
  venue_lat: number | null
  venue_lng: number | null
  organizer_address: string
  master_secret: string
  unlock_token: string
  staff_pass_salt: string | null
  staff_pass_hash: string | null
  hide_sold_count: number
  hide_redeemed_count: number
  hall_slot_id: string | null
  created_at: string
}

export interface HallSlotRow {
  id: string
  starts_at: string
  ends_at: string
  rent_luna: number
  status: string
  event_id: string | null
  renter_address: string | null
  rent_tx_hash: string | null
}

export interface TicketRow {
  id: string
  event_id: string
  buyer_address: string
  tx_hash: string
  ticket_seed: string
  status: TicketStatus
  created_at: string
  redeemed_at: string | null
  cancelled_at: string | null
  tier_id: string | null
  seat_id: string | null
}

export interface TierRow {
  id: string
  event_id: string
  name: string
  kind: TierKind
  price_luna: number
  capacity: number | null
  per_order_min: number
  per_order_max: number
  sales_starts_at: string | null
  sales_ends_at: string | null
  map_template: SeatTemplateId | null
  map_section: string | null
  sort_order: number
}

export interface SeatRow {
  id: string
  event_id: string
  tier_id: string
  label: string
  row_key: string
  x: number
  y: number
  status: SeatStatus
  held_until: string | null
  held_by: string | null
  hold_id: string | null
}

export interface HoldRow {
  id: string
  event_id: string
  buyer_key: string
  payload: string
  price_luna: number
  expires_at: string
  created_at: string
}

export interface WaitlistRow {
  id: string
  event_id: string
  address: string
  created_at: string
}
