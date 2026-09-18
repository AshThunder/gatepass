import type { SeatTemplateId } from '@gatepass/shared'

export interface SeatTemplateSeat {
  label: string
  rowKey: string
  x: number
  y: number
}

export const SEAT_TEMPLATES: Record<SeatTemplateId, { label: string, description: string }> = {
  'theater-200': {
    label: 'Theater (~120)',
    description: 'Curved rows facing a stage',
  },
  'club-80': {
    label: 'Small club (~48)',
    description: 'Compact floor grid',
  },
  'stadium-section': {
    label: 'Stadium section (~96)',
    description: 'One bowl section',
  },
  'nimiq-hall': {
    label: 'Nimiq Hall (100)',
    description: 'Platform hall · 100 labeled seats · rows A–J',
  },
}

/** Generate normalized (0–1) seat coordinates for a template. */
export function generateSeatLayout(template: SeatTemplateId): SeatTemplateSeat[] {
  if (template === 'club-80')
    return gridSeats(6, 8, 'C')
  if (template === 'stadium-section')
    return gridSeats(8, 12, 'S')
  if (template === 'nimiq-hall')
    return nimiqHallSeats()
  return theaterSeats()
}

function gridSeats(rows: number, cols: number, prefix: string): SeatTemplateSeat[] {
  const out: SeatTemplateSeat[] = []
  for (let r = 0; r < rows; r++) {
    const rowKey = `${prefix}${r + 1}`
    for (let c = 0; c < cols; c++) {
      out.push({
        label: `${rowKey}-${c + 1}`,
        rowKey,
        x: (c + 0.5) / cols,
        y: (r + 0.5) / rows,
      })
    }
  }
  return out
}

function theaterSeats(): SeatTemplateSeat[] {
  const out: SeatTemplateSeat[] = []
  const rows = 10
  for (let r = 0; r < rows; r++) {
    const rowKey = String.fromCharCode(65 + r)
    const cols = 8 + Math.floor(r / 2)
    for (let c = 0; c < cols; c++) {
      const t = (c + 0.5) / cols
      const curve = Math.sin(t * Math.PI) * 0.04
      out.push({
        label: `${rowKey}-${c + 1}`,
        rowKey,
        x: t,
        y: (r + 0.55) / rows - curve,
      })
    }
  }
  return out
}

/** Hard cap for Nimiq Hall — never generate more than this many seats. */
export const NIMIQ_HALL_CAPACITY = 100

/** Nimiq Hall: 10 rows (A–J), center aisle, 5+5 seats/row = 100. */
function nimiqHallSeats(): SeatTemplateSeat[] {
  const out: SeatTemplateSeat[] = []
  const rows = 10
  const left = 5
  const right = 5
  for (let r = 0; r < rows; r++) {
    const rowKey = String.fromCharCode(65 + r)
    let n = 1
    for (let c = 0; c < left; c++) {
      out.push({
        label: `${rowKey}-${n++}`,
        rowKey,
        x: 0.06 + (c / (left - 1 || 1)) * 0.34,
        y: (r + 0.55) / rows,
      })
    }
    for (let c = 0; c < right; c++) {
      out.push({
        label: `${rowKey}-${n++}`,
        rowKey,
        x: 0.58 + (c / (right - 1 || 1)) * 0.34,
        y: (r + 0.55) / rows,
      })
    }
  }
  if (out.length > NIMIQ_HALL_CAPACITY)
    return out.slice(0, NIMIQ_HALL_CAPACITY)
  return out
}
