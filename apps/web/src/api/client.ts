import type {
  AuthChallengeResponse,
  AuthSessionRequest,
  AuthSessionResponse,
  CreateEventRequest,
  CreateEventResponse,
  EventRecord,
  GateBundle,
  GuestRow,
  HoldRequest,
  HoldResponse,
  InboxTicket,
  InventorySnapshot,
  OutboxTransfer,
  PurchaseRequest,
  PurchaseResponse,
  SeatRecord,
  SeatTemplateId,
  HostUnlockResponse,
  StaffUnlockResponse,
  TicketRecord,
  TransferTicketResponse,
  WaitlistEntry,
} from '@gatepass/shared'

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data as T
}

export const api = {
  network: () => request<{
    network: string
    rpcUrl: string
    blockNumber: number | null
    minConfirmations: number
    skipTxVerify: boolean
    reachable: boolean
  }>('/network'),
  listEvents: () => request<{ events: EventRecord[] }>('/events'),
  getEvent: (id: string) => request<{ event: EventRecord }>(`/events/${id}`),
  inventory: (id: string, tierId?: string) =>
    request<InventorySnapshot>(
      `/events/${id}/inventory${tierId ? `?tierId=${encodeURIComponent(tierId)}` : ''}`,
    ),
  seats: (eventId: string, tierId: string) =>
    request<{ seats: SeatRecord[] }>(
      `/events/${eventId}/seats?tierId=${encodeURIComponent(tierId)}`,
    ),
  seatTemplates: () => request<{
    templates: Array<{ id: SeatTemplateId, label: string, description: string }>
  }>('/seat-templates'),
  getHall: () => request<import('@gatepass/shared').HallInfo>('/hall'),
  rentHall: (slotId: string, body: import('@gatepass/shared').RentHallRequest) =>
    request<import('@gatepass/shared').RentHallResponse>(`/hall/slots/${encodeURIComponent(slotId)}/rent`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createHold: (eventId: string, body: HoldRequest) =>
    request<HoldResponse>(`/events/${eventId}/holds`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createEvent: (body: CreateEventRequest) =>
    request<CreateEventResponse>('/events', { method: 'POST', body: JSON.stringify(body) }),
  purchase: (eventId: string, body: PurchaseRequest) =>
    request<PurchaseResponse>(`/events/${eventId}/purchase`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getTicket: (id: string) => request<{ ticket: TicketRecord }>(`/tickets/${id}`),
  redeem: (id: string, totp: string, deviceId?: string) =>
    request<{ ok: boolean, ticketId: string, redeemedAt: string }>(`/tickets/${id}/redeem`, {
      method: 'POST',
      body: JSON.stringify({ totp, deviceId }),
    }),
  cancelTicket: (id: string, unlockToken: string) =>
    request<{ ticket: TicketRecord }>(`/tickets/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ unlockToken }),
    }),
  transferTicket: (id: string, toAddress: string, fromAddress: string) =>
    request<TransferTicketResponse>(`/tickets/${id}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ toAddress, fromAddress }),
    }),
  authChallenge: () => request<AuthChallengeResponse>('/auth/challenge'),
  authSession: (body: AuthSessionRequest) =>
    request<AuthSessionResponse>('/auth/session', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  ticketInbox: (token: string) =>
    request<{ tickets: InboxTicket[] }>('/tickets/inbox', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ticketOutbox: (token: string) =>
    request<{ transfers: OutboxTransfer[] }>('/tickets/outbox', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  gateBundle: (eventId: string, token: string) =>
    request<GateBundle>(`/events/${eventId}/gate-bundle?token=${encodeURIComponent(token)}`),
  guests: (eventId: string, token: string) =>
    request<{ guests: GuestRow[] }>(`/events/${eventId}/guests?token=${encodeURIComponent(token)}`),
  waitlist: (eventId: string, token: string) =>
    request<{ waitlist: WaitlistEntry[] }>(`/events/${eventId}/waitlist?token=${encodeURIComponent(token)}`),
  joinWaitlist: (eventId: string, address: string) =>
    request<WaitlistEntry>(`/events/${eventId}/waitlist`, {
      method: 'POST',
      body: JSON.stringify({ address }),
    }),
  staffUnlock: (eventId: string, passcode: string) =>
    request<StaffUnlockResponse>(`/events/${eventId}/staff-unlock`, {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    }),
  hostUnlock: (eventId: string, sessionToken: string) =>
    request<HostUnlockResponse>(`/events/${eventId}/host-unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    }),
  setStaffPasscode: (eventId: string, unlockToken: string, passcode: string | null) =>
    request<{ ok: boolean, hasStaffPasscode: boolean, staffPasscode: string | null }>(
      `/events/${eventId}/staff-passcode`,
      {
        method: 'POST',
        body: JSON.stringify({ unlockToken, passcode }),
      },
    ),
}
