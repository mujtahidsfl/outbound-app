// Load a sequence written outside the app into the campaigns / campaign_leads tables.
// Usage: node --env-file=.env.local scripts/import_campaign.mjs [data/sequence.json]
// The JSON is an array of leads: { leadNo, email, name, shortName, trade, city, rating, reviews, website, status
// ('READY' | 'CHECK FIRST' | 'DO NOT SEND'), icebreaker, subjectNoun, subjectOwner, checks, emails: [{ step, day,
// thread, replyTo, subject, body }] }. leadNo is the lead's row in the leads table (sort_order + 1).
// Re-running updates the written emails and lead details but keeps the campaign's status, pause switch,
// screenshots and subject tests, and every approve.
import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

const CAMPAIGN = {
  id: 'example-campaign',
  name: 'Example Campaign',
  cadence: [3, 4, 4], // day 0, 3, 7, 11
  steps: [
    { n: 1, day: 0, thread: 'new' },
    { n: 2, day: 3, thread: 'new', attachImages: true }, // "I've attached a few screenshots"
    { n: 3, day: 7, thread: 'reply', replyTo: 2 },
    { n: 4, day: 11, thread: 'reply', replyTo: 2 },
  ],
}

const url = process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })
const file = process.argv[2] ?? new URL('../data/sequence.json', import.meta.url)
const parsed = JSON.parse(await readFile(file, 'utf8'))

// "Lead #N" in the document is the lead's row in the original sheet, i.e. sort_order N - 1.
const ids = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('leads').select('id').order('sort_order').range(from, from + 999)
  if (error) throw new Error(error.message)
  ids.push(...data.map(r => r.id))
  if (data.length < 1000) break
}
const plain = s => s.toLowerCase().replace(/[^a-z0-9@.]/g, '')
const problems = []
for (const l of parsed) {
  l.leadId = ids[l.leadNo - 1]
  // The sheet's address can carry junk (zero-width spaces, "maito:", phone digits); the document has the cleaned one.
  const domain = l.email.split('@')[1].toLowerCase()
  if (!l.leadId || !plain(l.leadId).endsWith(plain(domain))) problems.push(`Lead #${l.leadNo} ${l.email}: no matching lead (got ${l.leadId})`)
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}

// Send order: READY, then CHECK FIRST, then DO NOT SEND; within each, take turns between trades
// so every day's sends cover many trades (faster, fairer read on what works) and recipients vary.
const RANK = { READY: 0, 'CHECK FIRST': 1, 'DO NOT SEND': 2 }
const ordered = []
for (const status of Object.keys(RANK)) {
  const byTrade = new Map()
  for (const l of parsed.filter(x => x.status === status)) {
    if (!byTrade.has(l.trade)) byTrade.set(l.trade, [])
    byTrade.get(l.trade).push(l)
  }
  const queues = [...byTrade.values()]
  while (queues.some(q => q.length)) for (const q of queues) if (q.length) ordered.push(q.shift())
}

const { error: cErr } = await db.from('campaigns').upsert({ ...CAMPAIGN, status: 'paused', follow_ups_paused: true }, { onConflict: 'id', ignoreDuplicates: true })
if (cErr) throw new Error(cErr.message)
// Structure can change between imports; the switches people use stay as they are.
const { error: sErr } = await db.from('campaigns').update({ name: CAMPAIGN.name, cadence: CAMPAIGN.cadence }).eq('id', CAMPAIGN.id)
if (sErr) throw new Error(sErr.message)

const rows = ordered.map((l, i) => ({
  campaign_id: CAMPAIGN.id,
  lead_id: l.leadId,
  position: i,
  lead_no: l.leadNo,
  send_status: l.status,
  to_email: l.email.trim(),
  business_name: l.name,
  short_name: l.shortName,
  trade: l.trade,
  city: l.city,
  rating: l.rating ?? null,
  reviews: l.reviews ?? null,
  website: l.website || null,
  offer: l.offer ?? null,
  tier: l.tier ?? null,
  price: l.price ?? null,
  checks: l.checks,
  icebreaker: l.icebreaker,
  subject_noun: l.subjectNoun,
  subject_owner: l.subjectOwner,
  emails: l.emails.map(e => ({ step: e.step, day: e.day, thread: e.thread, replyTo: e.replyTo, subject: e.subject, body: e.body })),
}))

for (let i = 0; i < rows.length; i += 200) {
  const { error } = await db.from('campaign_leads').upsert(rows.slice(i, i + 200), { onConflict: 'campaign_id,lead_id' })
  if (error) {
    console.error(`Failed at rows ${i}-${i + 200}:`, error.message)
    process.exit(1)
  }
  process.stdout.write(`\r${Math.min(i + 200, rows.length)} / ${rows.length}`)
}
const counts = rows.reduce((m, r) => ({ ...m, [r.send_status]: (m[r.send_status] ?? 0) + 1 }), {})
console.log(`\nImported "${CAMPAIGN.name}":`, counts)
