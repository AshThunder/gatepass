# Privacy

GatePass stores the minimum data needed to sell and redeem tickets.

## What we store (API / database)

- Event title, times, venue text, optional coordinates
- Organizer NIM address
- Event master secret and gate unlock token (server-side; revealed once to organizer)
- Optional staff gate passcode **hash** (PIN itself is never stored)
- Ticket ids, buyer NIM addresses, payment transaction hashes
- Ticket seeds (derived from master secret)
- Redeem timestamps

## What we do not store

- Private keys or seed phrases
- Nimiq Pay credentials
- Full device camera footage (scanning is live on-device only)

## Client storage

- Last purchased ticket (including seed) in `localStorage` for display
- Gate bundle cache and pending redeem queue for offline check-in

## Wallet interactions

Sensitive actions (`listAccounts`, `sendBasicTransactionWithData`) go through Nimiq Pay native confirmation dialogs. GatePass never receives private keys.
