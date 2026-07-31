import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { HoldRequest, PurchaseItem, PurchaseRequest } from '@gatepass/shared'
import {
  cancelTicket,
  createEvent,
  createHold,
  getEvent,
  getGateBundle,
  getInventory,
  getTicket,
  handleError,
  joinWaitlist,
  listEvents,
  listGuests,
  listSeats,
  listWaitlist,
  purchaseTicket,
  redeemTicket,
  setStaffPasscode,
  staffUnlock,
  transferTicket,
} from './routes/events.js'
import { getNetworkStatus } from './nimiq-rpc.js'
import { SEAT_TEMPLATES } from './seat-templates.js'

/** API routes — mounted at `/` (local) and `/api` (production SPA). */
const api = new Hono()

api.get('/health', c => c.json({ ok: true, service: 'gatepass-api' }))

api.get('/network', async (c) => {
  try {
    return c.json(await getNetworkStatus())
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.get('/seat-templates', (c) => {
  return c.json({
    templates: Object.entries(SEAT_TEMPLATES).map(([id, meta]) => ({ id, ...meta })),
  })
})

api.get('/events', (c) => {
  try {
    return c.json({ events: listEvents() })
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.get('/events/:id', (c) => {
  try {
    return c.json({ event: getEvent(c.req.param('id')) })
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.get('/events/:id/inventory', (c) => {
  try {
    const tierId = c.req.query('tierId') || undefined
    return c.json(getInventory(c.req.param('id'), tierId))
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.get('/events/:id/seats', (c) => {
  try {
    const tierId = c.req.query('tierId')
    if (!tierId)
      return c.json({ error: 'tierId query required' }, 400)
    return c.json({ seats: listSeats(c.req.param('id'), tierId) })
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.post('/events', async (c) => {
  try {
    const body = await c.req.json()
    return c.json(createEvent(body), 201)
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.post('/events/:id/holds', async (c) => {
  try {
    const body = await c.req.json() as HoldRequest
    return c.json(createHold(c.req.param('id'), body), 201)
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.post('/events/:id/purchase', async (c) => {
  try {
    const body = await c.req.json() as PurchaseRequest
    if (!body.txHash || !body.buyerAddress)
      return c.json({ error: 'txHash and buyerAddress required' }, 400)
    const result = await purchaseTicket(
      c.req.param('id'),
      body.txHash,
      body.buyerAddress,
      body.demo,
      body.quantity ?? 1,
      body.items as PurchaseItem[] | undefined,
      body.holdId,
    )
    return c.json(result, 201)
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.get('/events/:id/gate-bundle', (c) => {
  try {
    const token = c.req.query('token')
    if (!token)
      return c.json({ error: 'token query required' }, 400)
    return c.json(getGateBundle(c.req.param('id'), token))
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.post('/events/:id/staff-unlock', async (c) => {
  try {
    const body = await c.req.json() as { passcode?: string }
    if (!body.passcode)
      return c.json({ error: 'passcode required' }, 400)
    return c.json(staffUnlock(c.req.param('id'), body.passcode))
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.post('/events/:id/staff-passcode', async (c) => {
  try {
    const body = await c.req.json() as { unlockToken?: string, passcode?: string | null }
    if (!body.unlockToken)
      return c.json({ error: 'unlockToken required' }, 400)
    return c.json(setStaffPasscode(
      c.req.param('id'),
      body.unlockToken,
      body.passcode === undefined ? null : body.passcode,
    ))
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.get('/events/:id/guests', (c) => {
  try {
    const token = c.req.query('token')
    if (!token)
      return c.json({ error: 'token query required' }, 400)
    return c.json({ guests: listGuests(c.req.param('id'), token) })
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.get('/events/:id/waitlist', (c) => {
  try {
    const token = c.req.query('token')
    if (!token)
      return c.json({ error: 'token query required' }, 400)
    return c.json({ waitlist: listWaitlist(c.req.param('id'), token) })
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.post('/events/:id/waitlist', async (c) => {
  try {
    const body = await c.req.json() as { address?: string }
    if (!body.address)
      return c.json({ error: 'address required' }, 400)
    return c.json(joinWaitlist(c.req.param('id'), body.address), 201)
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.get('/tickets/:id', (c) => {
  try {
    return c.json({ ticket: getTicket(c.req.param('id')) })
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.post('/tickets/:id/redeem', async (c) => {
  try {
    const body = await c.req.json() as { totp?: string }
    if (!body.totp)
      return c.json({ error: 'totp required' }, 400)
    return c.json(await redeemTicket(c.req.param('id'), body.totp))
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.post('/tickets/:id/cancel', async (c) => {
  try {
    const body = await c.req.json() as { unlockToken?: string }
    if (!body.unlockToken)
      return c.json({ error: 'unlockToken required' }, 400)
    return c.json({ ticket: cancelTicket(c.req.param('id'), body.unlockToken) })
  }
  catch (err) {
    return handleError(err, c)
  }
})

api.post('/tickets/:id/transfer', async (c) => {
  try {
    const body = await c.req.json() as { toAddress?: string, fromAddress?: string }
    if (!body.toAddress)
      return c.json({ error: 'toAddress required' }, 400)
    return c.json(await transferTicket(c.req.param('id'), body.toAddress, body.fromAddress))
  }
  catch (err) {
    return handleError(err, c)
  }
})

const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}))

app.route('/', api)
app.route('/api', api)

const staticDir = process.env.STATIC_DIR?.trim()
if (staticDir) {
  const root = path.resolve(staticDir)
  const indexHtml = path.join(root, 'index.html')

  app.use(
    '/*',
    serveStatic({
      root,
      rewriteRequestPath: p => p,
    }),
  )

  app.get('*', async (c) => {
    try {
      const html = await readFile(indexHtml, 'utf8')
      return c.html(html)
    }
    catch {
      return c.text('GatePass web build missing', 500)
    }
  })

  console.log(`Serving Mini App static files from ${root}`)
}

const port = Number(process.env.PORT || 8787)
console.log(`GatePass API listening on http://0.0.0.0:${port}`)
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' })
