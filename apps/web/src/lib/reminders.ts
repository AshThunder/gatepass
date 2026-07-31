/** Local reminder preferences + Notification API (best-effort; no push server). */

const KEY = 'gatepass:reminders'

export interface Reminder {
  eventId: string
  title: string
  startsAt: string
  /** ms before start */
  offsetMs: number
  notifyAt: number
}

function load(): Reminder[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]') as Reminder[]
  }
  catch {
    return []
  }
}

function save(items: Reminder[]) {
  localStorage.setItem(KEY, JSON.stringify(items))
}

export async function requestNotifyPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined')
    return false
  if (Notification.permission === 'granted')
    return true
  if (Notification.permission === 'denied')
    return false
  const res = await Notification.requestPermission()
  return res === 'granted'
}

export function setReminder(eventId: string, title: string, startsAt: string, offsetMs = 60 * 60 * 1000) {
  const starts = new Date(startsAt).getTime()
  const notifyAt = starts - offsetMs
  const items = load().filter(r => r.eventId !== eventId)
  items.push({ eventId, title, startsAt, offsetMs, notifyAt })
  save(items)
  return notifyAt
}

export function clearReminder(eventId: string) {
  save(load().filter(r => r.eventId !== eventId))
}

export function hasReminder(eventId: string) {
  return load().some(r => r.eventId === eventId)
}

/** Call on app mount — fires due reminders via Notification if permitted */
export function flushDueReminders() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted')
    return
  const now = Date.now()
  const remaining: Reminder[] = []
  for (const r of load()) {
    if (r.notifyAt <= now && new Date(r.startsAt).getTime() > now) {
      try {
        new Notification('GatePass reminder', {
          body: `${r.title} starts soon (${new Date(r.startsAt).toLocaleString()})`,
        })
      }
      catch {
        // ignore
      }
    }
    else if (new Date(r.startsAt).getTime() > now) {
      remaining.push(r)
    }
  }
  save(remaining)
}
