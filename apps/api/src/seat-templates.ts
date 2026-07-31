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
}

/** Generate normalized (0–1) seat coordinates for a template. */
export function generateSeatLayout(template: SeatTemplateId): SeatTemplateSeat[] {
  if (template === 'club-80')
    return gridSeats(6, 8, 'C')
  if (template === 'stadium-section')
    return gridSeats(8, 12, 'S')
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
      // slight curve
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
