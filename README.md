# GatePass

![GatePass](apps/web/public/thumbnail.png)

NIM-native event ticketing Mini App for **Nimiq Pay**.

Create an event → guests pay with NIM → rotating TOTP QR at the door → offline-capable gate scan → Proof of Attendance badge after the event.

## Try it

| | |
|---|---|
| **Live app** | https://gatepass-production-452c.up.railway.app |
| **Nimiq Pay deeplink** | `nimiqpay://miniapp?url=https://gatepass-production-452c.up.railway.app` |
| **Repo** | https://github.com/AshThunder/gatepass |

Open the live URL in a browser for a quick look, or open the deeplink inside **Nimiq Pay → Mini Apps** for real wallet payments.

## Problem

Crypto events still lean on PDF tickets and screenshot QR codes that anyone can copy. GatePass keeps ticketing where payments already happen: inside Nimiq Pay. Hosts sell tickets in NIM, guests get a time-based QR that is hard to fake, and door staff check people in with a dedicated Gate mode.

## Features

- **Discover** — browse upcoming events, search, filter by today / weekend / all
- **Buy with NIM** — `sendBasicTransactionWithData` via `@nimiq/mini-app-sdk`, memo-verified ticket issue
- **Demo tickets** — optional no-chain path for judges and dry runs (`VITE_ALLOW_DEMO` / `SKIP_TX_VERIFY`)
- **Tickets** — rotating TOTP QR pass, transfer, reminder, multi-ticket wallet view
- **Host** — simple price + capacity create, optional advanced tiers / seat maps, share night, guest list, staff PIN + QR
- **Gate** — host or staff unlock, camera scan, offline redeem queue + sync
- **Privacy toggles** — hide public sold / check-in counts; Host manage still sees full stats
- **Proof of Attendance** — badge after the event for checked-in guests

## How it works (no smart contracts)

GatePass uses Nimiq as a **payment rail**, not an NFT ticket ledger.

1. Host creates an event. API stores metadata and an event master secret.
2. Guest pays the organizer address with memo `GATEPASS:<eventId>` (quantity encoded when needed).
3. API verifies the tx over RPC (recipient, amount, memo, confirmations), then issues a ticket seed = HMAC(master, ticketId).
4. Guest shows a rotating TOTP QR derived from that seed.
5. Gate unlocks with the host unlock token (or staff PIN), verifies TOTP, marks the ticket redeemed.

Private keys never leave Nimiq Pay. Tickets are cryptographic credentials backed by on-chain payments and stored in SQLite.

## App tabs

| Tab | Role |
|-----|------|
| **Discover** | Browse and buy |
| **Tickets** | Show QR / badge |
| **Host** | Create, share, manage guests |
| **Gate** | Unlock door + scan |

## Stack

- `apps/web` — Vue 3 + Vite + `@nimiq/mini-app-sdk` (Nimiq gold / navy UI)
- `apps/api` — Hono + SQLite (events, payment verify, inventory, redeem)
- `packages/shared` — types + TOTP / QR helpers

Monorepo (npm workspaces). Single Docker image serves API + static Mini App (same origin, `/api/*`).

## Quick start

```bash
npm install
export SKIP_TX_VERIFY=true   # demo purchases without chain
npm run dev:api              # http://localhost:8787
npm run dev:web              # http://localhost:5173
```

Or:

```bash
docker compose up --build
```

Open `http://localhost:5173` in a browser, or the Vite **Network** URL inside **Nimiq Pay → Mini Apps**.

### Happy path (demo)

1. **Discover** → open an event  
2. **Get demo ticket** (or Pay with NIM in Nimiq Pay) → **Tickets** shows rotating QR  
3. **Host** → create event → save gate unlock QR  
4. **Gate** → unlock with host / staff QR → scan ticket QR  
5. After event end + 24h, a redeemed ticket shows the **Proof of Attendance** badge  

### Real NIM payments (Nimiq Pay)

```bash
# Mainnet (default RPC: https://rpc.nimiqwatch.com)
NIMIQ_NETWORK=mainnet SKIP_TX_VERIFY=false npm run dev:api

# Testnet — supply your own history-node RPC
NIMIQ_NETWORK=testnet NIMIQ_RPC_URL=http://<your-testnet-rpc>:8648 SKIP_TX_VERIFY=false npm run dev:api
```

1. Open the Mini App inside Nimiq Pay (LAN or hosted URL).
2. Host connects wallet (payout address must match the Pay network).
3. Guest taps **Pay with NIM** → confirms `sendBasicTransactionWithData` with memo `GATEPASS:<eventId>`.
4. API polls `getTransactionByHash`, checks recipient / amount / memo, then issues the ticket seed.
5. If the app closes after payment but before claim, reopen **Tickets** — pending `txHash` resumes from `localStorage`.

Check `/network` (or `/api/network` in production) for RPC reachability and tip height.

## Environment

**API** (`apps/api/.env.example`)

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port (Railway sets this) |
| `DB_PATH` | SQLite file path |
| `NIMIQ_NETWORK` | `mainnet` or `testnet` |
| `NIMIQ_RPC_URL` | Optional RPC override |
| `NIMIQ_MIN_CONFIRMATIONS` | Confirmations before issue (default `1`) |
| `SKIP_TX_VERIFY` | Allow `demo:true` purchases when `true` |
| `STATIC_DIR` | Serve Mini App build (set in Docker) |

**Web** (`apps/web/.env.example`)

| Variable | Purpose |
|----------|---------|
| `VITE_API_BASE_URL` | API base (`/api` in prod / Vite proxy) |
| `VITE_ALLOW_DEMO` | Show **Get demo ticket** button |

## Deploy (Railway)

One service serves Mini App + API.

```bash
npm i -g @railway/cli
railway login
railway init
railway up
railway volume add --mount-path /data   # persist SQLite
railway domain
```

Suggested variables:

| Variable | Value |
|----------|-------|
| `DB_PATH` | `/data/gatepass.db` |
| `NIMIQ_NETWORK` | `mainnet` |
| `SKIP_TX_VERIFY` | `true` (demo tickets work; **real Pay txs still verified**) |

Deeplink:

```text
nimiqpay://miniapp?url=https://YOUR-DOMAIN
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev:web` | Vite Mini App |
| `npm run dev:api` | API server |
| `npm test` | TOTP golden-vector tests |
| `npm run build` | Build shared + api + web |

## Privacy

See [docs/privacy.md](docs/privacy.md). Private keys never leave Nimiq Pay. The API stores event metadata, NIM addresses, ticket ids, and payment tx hashes.

## License

[MIT](LICENSE)
