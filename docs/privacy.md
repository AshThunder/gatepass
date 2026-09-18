# Privacy

GatePass stores the minimum data needed to sell, transfer, and redeem tickets.

## What we store (API / database)

- Event title, times, venue text, optional coordinates
- Organizer NIM address
- Event master secret and gate unlock token (server-side; revealed to the organizer when they unlock Host check-in)
- Optional staff gate passcode **hash** (the PIN itself is never stored in plaintext)
- Ticket ids, buyer NIM addresses, payment transaction hashes
- Ticket seeds (derived from the master secret)
- Redeem timestamps
- Ticket transfers (from / to addresses and ticket ids)
- Short-lived inbox sessions after a wallet `sign()` of a one-time challenge (or a demo session when `SKIP_TX_VERIFY` is on)

## What we do not store

- Private keys or seed phrases
- Nimiq Pay credentials
- Full device camera footage (scanning is live on-device only)

## Client storage

- Purchased and received tickets (including seed) in `localStorage` so the pass can be shown offline
- Gate bundle cache and pending redeem queue for offline check-in
- Optional local contacts (name + NIM address) for sending tickets
- Inbox session token until it expires

## Wallet interactions

`listAccounts`, `sign`, and `sendBasicTransactionWithData` go through Nimiq Pay native confirmation dialogs. GatePass never receives private keys.
