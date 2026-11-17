// Warm-up numbers for the sender account pages. Warm-up runs in Smartlead, so this copies each inbox's daily stats into
// warmup_stats a few times a day. Needs SMARTLEAD_API_KEY; without it the warm-up tiles say how to connect.
import type { Settings } from '../../src/types.ts'
import { db, inboxSchema } from './db.js'

const API = 'https://server.smartlead.ai/api/v1'
const EVERY_MS = 6 * 3600_000

const num = (...v: unknown[]) => Number(v.find(x => x != null) ?? 0) || 0

// The key travels in the URL, so errors report the status and never the URL.
async function get(path: string, query = '') {
  const res = await fetch(`${API}${path}?api_key=${encodeURIComponent(process.env.SMARTLEAD_API_KEY!)}${query}`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Smartlead answered ${res.status} for ${path}`)
  return res.json() as Promise<unknown>
}

/** Field names follow Smartlead's live API, with the names in its reference docs as a fallback. */
export function warmupRows(inbox: string, stats: Record<string, unknown>) {
  const days = (stats.stats_by_date ?? stats.daily_stats ?? []) as Record<string, unknown>[]
  return days.filter(d => d.date).map(d => {
    const sent = num(d.sent_count, d.sent)
    const saved = num(d.save_from_spam_count, d.spam_count, d.spam)
    return {
      inbox, day: String(d.date).slice(0, 10), sent, saved, received: num(d.received_count, d.reply_count, d.replied),
      inbox_hits: num(d.inbox_count, d.delivered, sent - saved), synced_at: new Date().toISOString(),
    }
  })
}

/** Copy the last 7 days for every sending inbox. `force` skips the few-hours spacing. */
export async function syncWarmup(settings: Settings, force = false): Promise<{ synced?: number; skipped?: string }> {
  if (!process.env.SMARTLEAD_API_KEY) return { skipped: 'SMARTLEAD_API_KEY is not set' }
  if (!(await inboxSchema())) return { skipped: 'master_inbox.sql has not been run' }
  if (!force) {
    const { data } = await db().from('warmup_stats').select('synced_at').order('synced_at', { ascending: false }).limit(1)
    if (Date.now() - (Date.parse(data?.[0]?.synced_at ?? '') || 0) < EVERY_MS) return { skipped: 'synced recently' }
  }
  const accounts: { id: number; from_email?: string }[] = []
  for (let offset = 0; ; offset += 100) {
    const page = await get('/email-accounts/', `&offset=${offset}&limit=100`) as { id: number; from_email?: string }[]
    accounts.push(...page)
    if (page.length < 100) break
  }
  const ids = new Map(accounts.map(a => [a.from_email?.toLowerCase(), a.id]))
  let synced = 0
  for (const inbox of settings.inboxes) {
    const id = ids.get(inbox.toLowerCase())
    if (!id) continue
    const rows = warmupRows(inbox, await get(`/email-accounts/${id}/warmup-stats`) as Record<string, unknown>)
    if (!rows.length) continue
    const { error } = await db().from('warmup_stats').upsert(rows, { onConflict: 'inbox,day' })
    if (error) throw new Error(error.message)
    synced++
  }
  return { synced }
}
