/** 1 NIM = 100_000 Luna */
export const LUNA_PER_NIM = 100_000

export const TOTP_PERIOD_SECONDS = 15
export const TOTP_DIGITS = 6
export const QR_PREFIX = 'GP1'

export const HOLD_TTL_MS = 3 * 60 * 1000

export type TicketStatus = 'valid' | 'redeemed' | 'cancelled'

export type TierKind = 'ga' | 'vip' | 'early_bird' | 'student' | 'group' | 'reserved'

export type SeatStatus = 'available' | 'held' | 'sold'

export type SeatTemplateId = 'theater-200' | 'club-80' | 'stadium-section'

export interface TicketTier {
  id: string
  eventId: string
  name: string
  kind: TierKind
  priceLuna: number
  /** null = unlimited */
  capacity: number | null
  perOrderMin: number
  perOrderMax: number
  salesStartsAt: string | null
  salesEndsAt: string | null
  mapTemplate: SeatTemplateId | null
  mapSection: string | null
  sortOrder: number
  soldCount: number
  remaining: number | null
  soldOut: boolean
  onSale: boolean
}

export interface SeatRecord {
  id: string
  eventId: string
  tierId: string
  label: string
  rowKey: string
  x: number
  y: number
  status: SeatStatus
  heldUntil: string | null
}

export interface EventRecord {
  id: string
  title: string
  description: string
  coverUrl: string | null
  /** ISO 8601 event start */
  startsAt: string
  /** ISO 8601 event end */
  endsAt: string
  /** Lowest tier price in Luna (Discover “from”) */
  priceLuna: number
  /** Sum of tier capacities; null if any tier is unlimited */
  capacity: number | null
  venueName: string
  venueLat: number | null
  venueLng: number | null
  organizerAddress: string
  createdAt: string
  /** Non-cancelled tickets */
  soldCount: number
  redeemedCount: number
  waitlistCount: number
  soldOut: boolean
  /** Remaining tickets; null = unlimited */
  remaining: number | null
  /** True when organizer set a staff gate passcode */
  hasStaffPasscode: boolean
  /** Hide sold / “going” from public Discover & event pages */
  hideSoldCount: boolean
  /** Hide check-in counts from public Discover & event pages */
  hideRedeemedCount: boolean
  tiers: TicketTier[]
}

export interface TicketRecord {
  id: string
  eventId: string
  buyerAddress: string
  txHash: string
  /** Hex-encoded ticket seed (HMAC of master + ticket id) */
  ticketSeed: string
  status: TicketStatus
  createdAt: string
  redeemedAt: string | null
  cancelledAt: string | null
  tierId: string | null
  tierName: string | null
  seatId: string | null
  seatLabel: string | null
}

export interface CreateTierInput {
  name: string
  kind: TierKind
  /** Price in NIM */
  priceNim: number
  capacity?: number | null
  perOrderMin?: number
  perOrderMax?: number
  salesStartsAt?: string | null
  salesEndsAt?: string | null
  mapTemplate?: SeatTemplateId | null
  mapSection?: string | null
}

export interface CreateEventRequest {
  title: string
  description?: string
  coverUrl?: string | null
  startsAt: string
  endsAt: string
  /** Legacy single price in NIM — used when tiers omitted */
  priceNim?: number
  /** Legacy max tickets; omit/null = unlimited */
  capacity?: number | null
  /** Prefer this over priceNim/capacity */
  tiers?: CreateTierInput[]
  venueName: string
  venueLat?: number | null
  venueLng?: number | null
  organizerAddress: string
  /** Optional PIN for door staff (not the host unlock QR) */
  staffPasscode?: string | null
  /** Hide sold count on public surfaces */
  hideSoldCount?: boolean
  /** Hide check-in count on public surfaces */
  hideRedeemedCount?: boolean
}

export interface CreateEventResponse {
  event: EventRecord
  eventMasterSecret: string
  gateUnlockToken: string
  /** Echoed once if set — staff use this at the Gate tab */
  staffPasscode: string | null
}

export interface PurchaseItem {
  tierId: string
  quantity?: number
  seatIds?: string[]
}

export interface PurchaseRequest {
  txHash: string
  buyerAddress: string
  /** Legacy: number of GA tickets (default 1) when items omitted */
  quantity?: number
  /** Preferred multi-tier cart */
  items?: PurchaseItem[]
  holdId?: string
  demo?: boolean
}

export interface PurchaseResponse {
  tickets: TicketRecord[]
  /** @deprecated use tickets[0] */
  ticket: TicketRecord
}

export interface HoldRequest {
  buyerKey: string
  items: PurchaseItem[]
}

export interface HoldResponse {
  holdId: string
  expiresAt: string
  priceLuna: number
  items: PurchaseItem[]
}

export interface InventorySnapshot {
  eventId: string
  syncedAt: string
  tiers: Array<{
    id: string
    soldCount: number
    remaining: number | null
    soldOut: boolean
    onSale: boolean
  }>
  seats?: Array<{ id: string, status: SeatStatus, heldUntil: string | null }>
}

export interface RedeemRequest {
  totp: string
  deviceId?: string
}

export interface GateBundle {
  eventId: string
  eventTitle: string
  endsAt: string
  eventMasterSecret: string
  syncedAt: string
  tickets: Array<{ id: string, ticketSeed: string, status: TicketStatus }>
}

export interface StaffUnlockRequest {
  passcode: string
}

export interface StaffUnlockResponse {
  eventId: string
  gateUnlockToken: string
  eventMasterSecret: string
  bundle: GateBundle
}

export interface GuestRow {
  ticketId: string
  buyerAddress: string
  status: TicketStatus
  txHash: string
  createdAt: string
  redeemedAt: string | null
  cancelledAt: string | null
  tierName: string | null
  seatLabel: string | null
}

export interface WaitlistEntry {
  id: string
  eventId: string
  address: string
  createdAt: string
}

export function nimToLuna(nim: number): number {
  return Math.round(nim * LUNA_PER_NIM)
}

export function lunaToNim(luna: number): number {
  return luna / LUNA_PER_NIM
}

export function paymentMemo(eventId: string, quantity = 1): string {
  return quantity > 1 ? `GATEPASS:${eventId}:Q${quantity}` : `GATEPASS:${eventId}`
}

/** Compact memo for multi-tier carts (qty = total tickets). */
export function paymentMemoForCart(eventId: string, totalTickets: number): string {
  return paymentMemo(eventId, totalTickets)
}

/** True when event ended more than 24h ago */
export function isBadgePhase(endsAt: string, now = Date.now()): boolean {
  return now >= new Date(endsAt).getTime() + 24 * 60 * 60 * 1000
}

export function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

export function eventSharePath(eventId: string): string {
  return `?tab=discover&event=${encodeURIComponent(eventId)}`
}

export function tierOnSale(
  tier: Pick<TicketTier, 'salesStartsAt' | 'salesEndsAt'>,
  now = Date.now(),
): boolean {
  if (tier.salesStartsAt && now < new Date(tier.salesStartsAt).getTime())
    return false
  if (tier.salesEndsAt && now > new Date(tier.salesEndsAt).getTime())
    return false
  return true
}
