# GatePass

![GatePass](apps/web/public/thumbnail.png)

NIM-native event ticketing Mini App for **Nimiq Pay**.

Create an event → guests pay with NIM → rotating TOTP QR at the door → Gate scan → Proof of Attendance after the show.

## Try it

| | |
|---|---|
| **Live app** | https://gpass.up.railway.app |
| **Nimiq Pay deeplink** | `nimiqpay://miniapp?url=https://gpass.up.railway.app` |
| **Repo** | https://github.com/AshThunder/gatepass |

Open the live URL in a browser for a quick look. Open the deeplink inside **Nimiq Pay → Mini Apps** for wallet connect, sign-in, and real NIM payments.

## Problem

Crypto events still lean on PDF tickets and screenshot QR codes that anyone can copy. GatePass keeps ticketing where payments already happen: inside Nimiq Pay. Hosts sell tickets in NIM, guests get a time-based QR that is hard to fake, and door staff check people in from the host phone or with a staff PIN on Gate.

## Features

- **Discover** — upcoming events, search, today / weekend / all; **Nimiq Hall** nights get a Hall chip
- **Nimiq Hall** — rent a platform venue evening (100 labeled seats, rows A–J) and sell the map
- **Buy with NIM** — `sendBasicTransactionWithData` via `@nimiq/mini-app-sdk`; memo-verified issue
- **Demo tickets** — optional no-chain path for dry runs (`VITE_ALLOW_DEMO` / `SKIP_TX_VERIFY`)
- **Tickets** — rotating TOTP pass, send to a friend, inbox, reminder, Proof of Attendance badge
- **Host** — Create or book the hall → My events: share link, **Check in guests**, staff PIN
- **Gate** — host check-in unlocks the door on this phone; staff type the PIN; tablet mode `?tab=gate&tablet=1`
- **Seat holds** — reserved seats lock for a few minutes while you pay
- **Privacy toggles** — hide public sold / check-in counts; Host manage still sees full stats

## How it works (no smart contracts)

GatePass uses Nimiq as a **payment rail**, not an NFT ticket ledger.

1. Host creates an event (or rents **Nimiq Hall**). API stores metadata and an event master secret.
2. Guest pays the organizer address with memo `GATEPASS:<eventId>` (quantity encoded when needed). Hall rent uses memo `GATEPASS:HALL:<slotId>` to the platform address.
3. API verifies the tx over RPC (recipient, amount, memo, confirmations), then issues a ticket seed = HMAC(master, ticketId).
4. Guest shows a rotating TOTP QR derived from that seed.
5. Host taps **Check in guests**, or staff type the door PIN on Gate. TOTP is verified and the ticket is marked redeemed.

Private keys never leave Nimiq Pay. Tickets are cryptographic credentials backed by on-chain payments and stored in SQLite.

## App tabs

| Tab | Role |
|-----|------|
| **Discover** | Browse and buy |
| **Tickets** | Show QR / send / inbox |
| **Host** | Create, book Hall, check in, guests |
| **Gate** | Staff PIN + scan (tablet-friendly) |

## Stack

- `apps/web` — Vue 3 + Vite + `@nimiq/mini-app-sdk`
- `apps/api` — Hono + SQLite (events, payment verify, inventory, redeem)
- `packages/shared` — types, TOTP / QR, Nimiq address helpers

Monorepo (npm workspaces). One Docker image serves API + Mini App (same origin, `/api/*`).

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

Open `http://localhost:5173`, or the Vite Network URL inside **Nimiq Pay → Mini Apps**.

### Happy path (demo)

**Fast path (~60s):**

1. **Discover** → open a listed event (or **Host** → Create / Book Nimiq Hall)
2. Pick GA or a labeled seat → **Get demo ticket** (or **Pay with NIM** in Pay)
3. **Tickets** shows the rotating QR
4. **Host → My events** → **Check in guests** (or **Gate** + staff PIN) → scan → ACCEPT

**After the event:** a redeemed ticket shows the **Proof of Attendance** badge (24h after end).

### Real NIM payments (Nimiq Pay)

```bash
# Mainnet (default RPC: https://rpc.nimiqwatch.com)
NIMIQ_NETWORK=mainnet SKIP_TX_VERIFY=false npm run dev:api

# Testnet — supply your own history-node RPC
NIMIQ_NETWORK=testnet NIMIQ_RPC_URL=http://<your-testnet-rpc>:8648 SKIP_TX_VERIFY=false npm run dev:api
```

1. Open the Mini App inside Nimiq Pay.
2. Host connects — payout address must match the Pay network.
3. Guest taps **Pay with NIM** → confirms `sendBasicTransactionWithData` with memo `GATEPASS:<eventId>`.
4. API polls `getTransactionByHash`, checks recipient / amount / memo, then issues the ticket seed.
5. If the app closes after payment, reopen **Tickets** — pending `txHash` resumes from `localStorage`.

Check `/network` (or `/api/network` in production) for RPC reachability and tip height.

`SKIP_TX_VERIFY=true` only allows client `demo:true` purchases. Real Pay transactions are still verified on-chain.

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
| `HALL_NAME` | Platform venue label (default `Nimiq Hall`) |
| `HALL_RENT_NIM` | Slot rent in NIM (default `5`) |
| `HALL_PLATFORM_ADDRESS` | NIM address that receives hall rent |
| `STATIC_DIR` | Serve Mini App build (set in Docker) |

**Web** (`apps/web/.env.example`)

| Variable | Purpose |
|----------|---------|
| `VITE_API_BASE_URL` | API base (`/api` in prod / Vite proxy) |
| `VITE_ALLOW_DEMO` | Show **Get demo ticket** |

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

Live example: https://gpass.up.railway.app

```text
nimiqpay://miniapp?url=https://YOUR-DOMAIN
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev:web` | Vite Mini App |
| `npm run dev:api` | API |
| `npm test` | Shared unit tests (TOTP, addresses) |
| `npm run build` | Build shared + api + web |

## Privacy

See [docs/privacy.md](docs/privacy.md). Private keys never leave Nimiq Pay. The API stores event metadata, NIM addresses, ticket ids, payment tx hashes, and signed inbox sessions.

## License

[MIT](LICENSE)
