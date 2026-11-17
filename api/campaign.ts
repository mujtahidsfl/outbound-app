// Building campaigns in the app. Requires a signed-in dashboard user.
//   { action: 'create', name, folder? }             a new paused campaign
//   { action: 'add-leads', campaignId, rows }       add leads from an uploaded list (the browser sends them in batches)
//   { action: 'delete', campaignId }                delete a campaign nothing has been sent from
import { resolveMx } from 'node:dns/promises'
import { NEW_CAMPAIGN_CONFIG, fetchAll } from '../src/core.js'
import { db, inboxSchema, userFromRequest } from './_lib/db.js'
import { errorMessage, json } from './_lib/env.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ROWS = 1000

type Row = { email: string; company?: string; city?: string; website?: string; vars?: Record<string, string> }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'campaign'

/** Which domains can receive mail. A dead domain is a guaranteed bounce, so its leads are never sent to. */
async function mailDomains(domains: string[]) {
  const ok = new Set<string>()
  const queue = [...domains]
  await Promise.all(Array.from({ length: 20 }, async () => {
    for (let d = queue.pop(); d; d = queue.pop()) {
      const mx = await Promise.race([resolveMx(d).catch(() => null), new Promise<null>(r => setTimeout(() => r(null), 4000))])
      if (mx?.length) ok.add(d)
    }
  }))
  return ok
}

/** Add leads to a campaign. Anyone already in a campaign, or already emailed or stopped, is left alone and counted. */
async function addLeads(campaignId: string, rows: Row[]) {
  const seen = new Set<string>()
  const clean = rows.flatMap(r => {
    const email = r.email?.trim().toLowerCase()
    if (!email || !EMAIL.test(email) || seen.has(email)) return []
    seen.add(email)
    return [{ ...r, email }]
  })
  const invalid = rows.length - clean.length
  const ids = clean.map(r => r.email)
  const [taken, contacted] = await Promise.all([
    db().from('campaign_leads').select('lead_id').in('lead_id', ids),
    db().from('lead_tracking').select('lead_id').in('lead_id', ids).or('sent_at.not.is.null,bad_reason.not.is.null'),
  ])
  if (taken.error || contacted.error) throw new Error((taken.error ?? contacted.error)!.message)
  const skip = new Set([...(taken.data ?? []), ...(contacted.data ?? [])].map(r => r.lead_id as string))
  const fresh = clean.filter(r => !skip.has(r.email))
  if (!fresh.length) return { added: 0, skipped: skip.size, invalid, noMail: 0 }

  const live = await mailDomains([...new Set(fresh.map(r => r.email.split('@')[1]))])
  const [{ data: last }, { data: lastLead }] = await Promise.all([
    db().from('campaign_leads').select('position').eq('campaign_id', campaignId).order('position', { ascending: false }).limit(1),
    db().from('leads').select('sort_order').order('sort_order', { ascending: false }).limit(1),
  ])
  const position = (last?.[0]?.position ?? -1) + 1
  const sortOrder = (lastLead?.[0]?.sort_order ?? 0) + 1
  const name = (r: Row) => r.company?.trim() || r.vars?.company_name || r.email.split('@')[1]

  const leads = await db().from('leads').upsert(fresh.map((r, i) => ({
    id: r.email, email: r.email, sort_order: sortOrder + i, business_name: name(r), city: r.city ?? '', website: r.website ?? '',
  })), { onConflict: 'id', ignoreDuplicates: true })
  if (leads.error) throw new Error(leads.error.message)

  const vars = await inboxSchema()
  const ins = await db().from('campaign_leads').insert(fresh.map((r, i) => {
    const dead = !live.has(r.email.split('@')[1])
    return {
      campaign_id: campaignId, lead_id: r.email, position: position + i, send_status: dead ? 'DO NOT SEND' : 'READY', to_email: r.email,
      business_name: name(r), short_name: name(r), trade: '', city: r.city ?? '', website: r.website ?? '', checks: dead ? ['DO NOT SEND: this domain has no mail server'] : [], emails: [],
      ...(vars ? { vars: r.vars ?? {} } : {}),
    }
  }))
  if (ins.error) throw new Error(ins.error.message)
  return { added: fresh.length, skipped: skip.size, invalid, noMail: fresh.filter(r => !live.has(r.email.split('@')[1])).length }
}

export async function POST(request: Request) {
  let user
  try {
    user = await userFromRequest(request)
  } catch (e) {
    return json({ error: `Sending isn't set up yet: ${errorMessage(e)}` }, 503)
  }
  if (!user) return json({ error: 'Sign in again to continue.' }, 401)

  let body: { action?: string; campaignId?: string; name?: string; folder?: string; rows?: Row[] }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: 'Bad request' }, 400)
  }

  try {
    if (!(await inboxSchema())) return json({ error: 'Run supabase/master_inbox.sql in Supabase first.' }, 400)

    if (body.action === 'create') {
      const name = body.name?.trim()
      if (!name) return json({ error: 'Give the campaign a name' }, 400)
      const ids = new Set((await fetchAll<{ id: string }>((from, to) => db().from('campaigns').select('id').range(from, to))).map(c => c.id))
      let id = slug(name)
      for (let n = 2; ids.has(id); n++) id = `${slug(name)}-${n}`
      const { error } = await db().from('campaigns').insert({
        id, name, status: 'paused', follow_ups_paused: false, cadence: [], steps: [{ n: 1, day: 0, thread: 'new' }],
        config: { ...NEW_CAMPAIGN_CONFIG, ...(body.folder?.trim() ? { folder: body.folder.trim() } : {}) },
      })
      if (error) throw new Error(error.message)
      return json({ ok: true, id })
    }

    if (body.action === 'add-leads') {
      const { campaignId, rows } = body
      if (!campaignId || !rows?.length) return json({ error: 'No leads to add' }, 400)
      if (rows.length > MAX_ROWS) return json({ error: `Send at most ${MAX_ROWS} leads at a time` }, 400)
      return json({ ok: true, ...(await addLeads(campaignId, rows)) })
    }

    if (body.action === 'delete') {
      const { campaignId } = body
      if (!campaignId) return json({ error: 'Missing campaign' }, 400)
      const { count } = await db().from('email_messages').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId)
      if (count) return json({ error: "This campaign has sent emails, so it can't be deleted. Pause it instead." }, 400)
      const { error } = await db().from('campaigns').delete().eq('id', campaignId)
      if (error) throw new Error(error.message)
      return json({ ok: true })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    return json({ error: errorMessage(e) }, 500)
  }
}
