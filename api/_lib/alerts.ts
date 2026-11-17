// Deliverability alerts: the guard describes every problem it sees on each pass; this keeps the alerts table in step
// (new problems open an alert, gone ones resolve it). They're emailed in the end-of-day digest, not one by one.
import { db } from './db.js'

export interface AlertDraft {
  /** One open alert per key, e.g. "bounces:alex@yourdomain.com". */
  key: string
  level: 'warn' | 'critical'
  title: string
  detail: string
  inbox: string | null
}

type Open = AlertDraft & { id: number }

/** Open, update and resolve alerts to match `drafts`. Keys under a `skipped` prefix weren't re-checked and stay as they are. */
export async function syncAlerts(drafts: AlertDraft[], skipped: string[]): Promise<string[]> {
  const res = await db().from('alerts').select('id,key,level,title,detail,inbox').is('resolved_at', null)
  if (res.error) return [] // guard.sql not run yet
  const open = new Map((res.data as Open[]).map(a => [a.key, a]))
  const now = new Date().toISOString()
  const notes: string[] = []

  for (const d of new Map(drafts.map(x => [x.key, x])).values()) {
    const cur = open.get(d.key)
    open.delete(d.key)
    if (!cur) {
      const ins = await db().from('alerts').insert({ ...d, updated_at: now })
      if (!ins.error) notes.push(`alert: ${d.title}`)
    } else if (cur.title !== d.title || cur.detail !== d.detail || cur.level !== d.level) {
      await db().from('alerts').update({ level: d.level, title: d.title, detail: d.detail, updated_at: now }).eq('id', cur.id)
    }
  }
  const gone = [...open.values()].filter(a => !skipped.some(p => a.key.startsWith(p)))
  if (gone.length) {
    await db().from('alerts').update({ resolved_at: now }).in('id', gone.map(a => a.id))
    notes.push(...gone.map(a => `resolved: ${a.title}`))
  }
  return notes
}
