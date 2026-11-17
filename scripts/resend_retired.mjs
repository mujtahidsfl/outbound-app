// Resend everything the retired inboxes sent, from the live inboxes on other domains.
//   node scripts/resend_retired.mjs                 dry run: what would be removed and requeued
//   node scripts/resend_retired.mjs --apply         back up, remove the old sends, requeue the leads
// Retired inboxes = settings.retiredInboxes (they stay in the reply check so a "no" to an old email still counts).
// Leads who replied, bounced or opted out are left alone. Leads who opened the old email aren't resent: they keep
// their record, move to a new inbox for their follow-ups, and get a note saying so. Each requeued lead is pinned to one new inbox,
// weighted by that inbox's daily cap, and autopilot sends it as a fresh Email 1.
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const env = Object.fromEntries(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')
  .filter(l => /^\w+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const db = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const apply = process.argv.includes('--apply')
// Domains that keep sending fresh leads and take no resends (they were already landing).
const KEEP_DOMAINS = (process.argv.find(a => a.startsWith('--keep='))?.slice(7) ?? '').split(',').filter(Boolean)

async function all(table, cols, f = q => q, key = 'id') {
  const out = []
  for (let i = 0; ; i += 1000) {
    const { data, error } = await f(db.from(table).select(cols)).order(key).range(i, i + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data)
    if (data.length < 1000) return out
  }
}

const { data: row, error } = await db.from('app_settings').select('data').eq('id', 1).single()
if (error) throw error
const settings = row.data
const retired = settings.retiredInboxes ?? []
if (!retired.length) throw new Error('settings.retiredInboxes is empty')
const domainOf = i => i.split('@')[1]
const targets = settings.inboxes.filter(i => !retired.includes(i) && !KEEP_DOMAINS.includes(domainOf(i)))
if (!targets.length) throw new Error('No live inboxes to resend from')
const cap = i => settings.inboxLimits?.[i] ?? settings.inboxDailyLimit

const msgs = await all('email_messages', '*', q => q.in('inbox', retired))
const leadIds = [...new Set(msgs.map(m => m.lead_id).filter(Boolean))]
const events = (await all('email_events', 'lead_id,kind,inbox')).filter(e => leadIds.includes(e.lead_id))
const tracks = new Map((await all('lead_tracking', '*', q => q, 'lead_id')).map(t => [t.lead_id, t]))
const members = new Map((await all('campaign_leads', 'lead_id,position', q => q, 'lead_id')).map(m => [m.lead_id, m]))

const stopped = new Set(events.filter(e => e.kind !== 'auto').map(e => e.lead_id))
const opened = new Set(msgs.filter(m => m.opened_at && m.lead_id).map(m => m.lead_id))
const skip = [], requeue = [], openers = []
for (const id of leadIds) {
  const t = tracks.get(id)
  const why = stopped.has(id) ? 'replied/bounced/opted out' : t?.replied_at ? 'replied' : t?.bad_reason ? t.bad_reason
    : t?.follow_ups?.length ? 'has follow-ups' : t && t.inbox && !retired.includes(t.inbox) ? `already on ${t.inbox}` : null
  if (why) skip.push([id, why])
  else if (opened.has(id)) openers.push(id)
  else requeue.push(id)
}
requeue.sort((a, b) => (members.get(a)?.position ?? 1e9) - (members.get(b)?.position ?? 1e9))

// Weighted round robin: an inbox with twice the cap gets twice the leads.
const slots = targets.flatMap(i => Array(cap(i)).fill(i))
const order = slots.map((i, k) => ({ i, k: (k % cap(i)) / cap(i) + Math.random() * 1e-6 })).sort((a, b) => a.k - b.k).map(x => x.i)
const assign = new Map([...requeue, ...openers].map((id, k) => [id, order[k % order.length]]))

const perInbox = {}
for (const i of assign.values()) perInbox[i] = (perInbox[i] ?? 0) + 1
console.log(`Retired inboxes: ${retired.join(', ')}`)
console.log(`Emails to remove: ${msgs.length} (${msgs.filter(m => m.opened_at).length} had been opened)`)
console.log(`Leads to resend: ${requeue.length}; opened (kept, follow-ups from a new inbox): ${openers.length}; left alone: ${skip.length}`, skip)
console.log('Resend from:', perInbox, `≈ ${Math.ceil(requeue.length / targets.reduce((s, i) => s + cap(i), 0))} sending day(s)`)
if (!apply) process.exit(0)

const backup = new URL(`../data/retired-sends-backup-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url)
fs.writeFileSync(backup, JSON.stringify({ retired, messages: msgs, tracking: [...requeue, ...openers].map(id => tracks.get(id)), guard: (await db.from('inbox_guard').select('*').in('inbox', retired)).data }, null, 1))
console.log(`Backed up to ${backup.pathname}`)

for (const id of requeue) {
  const r = tracks.has(id)
    ? await db.from('lead_tracking').update({ sent_at: null, inbox: assign.get(id) }).eq('lead_id', id)
    : await db.from('lead_tracking').insert({ lead_id: id, inbox: assign.get(id) })
  if (r.error) throw new Error(`${id}: ${r.error.message}`)
}
const md = iso => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
for (const id of openers) {
  const t = tracks.get(id)
  const m = msgs.find(x => x.lead_id === id && x.opened_at)
  const note = `Opened Email 1 (sent ${md(m.sent_at)} from ${m.inbox}, opened ${md(m.opened_at)}). Not resent when that domain was retired; follow-ups go from ${assign.get(id)}.`
  const r = await db.from('lead_tracking').update({ inbox: assign.get(id), notes: t.notes ? `${t.notes}\n${note}` : note }).eq('lead_id', id)
  if (r.error) throw new Error(`${id}: ${r.error.message}`)
}
// Only the emails of requeued leads are removed; a skipped lead keeps its record of what it was sent.
const gone = msgs.filter(m => !m.lead_id || requeue.includes(m.lead_id)).map(m => m.id)
for (let i = 0; i < gone.length; i += 200) {
  const r = await db.from('email_messages').delete().in('id', gone.slice(i, i + 200))
  if (r.error) throw new Error(r.error.message)
}
const g = await db.from('inbox_guard').delete().in('inbox', retired)
if (g.error) console.warn('inbox_guard:', g.error.message)
console.log(`Removed ${gone.length} emails, requeued ${requeue.length} leads, noted ${openers.length} openers.`)
