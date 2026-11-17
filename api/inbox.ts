// Master inbox actions. Requires a signed-in dashboard user.
//   { action: 'thread', leadId }                                    the whole conversation, newest last
//   { action: 'reply', leadId, inbox, to, subject, body, sendAt? }  send now, or at sendAt (ISO time)
//   { action: 'cancel-scheduled', id }                              cancel a scheduled reply
//   { action: 'warmup-sync' }                                       copy warm-up stats from Smartlead now
//   { action: 'all-mail', inbox?, search?, limit? }                 everything in the inboxes, read live (see _lib/allmail.ts)
//   { action: 'all-mail-read', inbox, uid }                         one of those emails, as plain text
import { composeCampaignEmail, inboxPersona } from '../src/core.js'
import type { Settings } from '../src/types.ts'
import { listMail, readMail } from './_lib/allmail.js'
import { db, inboxSchema, loadCampaignLead, loadSettings, userFromRequest } from './_lib/db.js'
import { errorMessage, json } from './_lib/env.js'
import { loginInboxes } from './_lib/google.js'
import { replyDefaults, sendReply } from './_lib/reply.js'
import { syncWarmup } from './_lib/smartlead.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface ThreadMessage {
  id: string; dir: 'in' | 'out'; at: string; from: string; to: string; subject: string; body: string
  /** Sequence email number, or how the message was written. */
  step: number | null; source?: string; kind?: string; opened?: boolean; clicked?: boolean
}

/** Emails sent before bodies were stored: rebuilt from the campaign, or left at the subject. */
async function rebuilt(leadId: string, step: number, inbox: string, settings: Settings) {
  const camp = await loadCampaignLead(leadId, settings).catch(() => null)
  return camp?.emails[step] ? composeCampaignEmail(camp.campaign, camp.member, camp.emails, step, inbox).body : ''
}

async function thread(leadId: string, settings: Settings): Promise<ThreadMessage[]> {
  const schema = await inboxSchema()
  const cols = `id,step,inbox,to_email,subject,sent_at,created_at,source,opened_at${schema ? ',clicked_at,body_text' : ''}`
  type Row = { id: number; step: number; inbox: string; to_email: string; subject: string | null; sent_at: string | null; created_at: string; source: string; opened_at: string | null; clicked_at?: string | null; body_text?: string | null }
  const [sent, oneOff, back] = await Promise.all([
    db().from('email_messages').select(cols).eq('lead_id', leadId).eq('status', 'sent'),
    schema ? db().from('email_messages').select(cols).eq('thread_lead_id', leadId).eq('status', 'sent') : { data: [], error: null },
    db().from('email_events').select(`id,inbox,kind,from_email,subject,snippet,received_at,created_at${schema ? ',body_text' : ''}`).eq('lead_id', leadId).in('kind', ['reply', 'unsubscribe', 'auto', 'bounce']),
  ])
  for (const r of [sent, back]) if (r.error) throw new Error(r.error.message)
  const out = await Promise.all(((sent.data ?? []) as unknown as Row[]).map(async (m): Promise<ThreadMessage> => ({
    id: `m${m.id}`, dir: 'out', at: m.sent_at ?? m.created_at, from: m.inbox, to: m.to_email, subject: m.subject ?? '', step: m.step, source: m.source,
    body: m.body_text ?? await rebuilt(leadId, m.step, m.inbox, settings), opened: !!m.opened_at, clicked: !!m.clicked_at,
  })))
  for (const m of (oneOff.data ?? []) as unknown as Row[]) {
    out.push({ id: `m${m.id}`, dir: 'out', at: m.sent_at ?? m.created_at, from: m.inbox, to: m.to_email, subject: m.subject ?? '', step: null, source: m.source, body: m.body_text ?? '' })
  }
  type Evt = { id: number; inbox: string; kind: string; from_email: string | null; subject: string | null; snippet: string | null; received_at: string | null; created_at: string; body_text?: string | null }
  for (const e of (back.data ?? []) as unknown as Evt[]) {
    out.push({
      id: `e${e.id}`, dir: 'in', at: e.received_at ?? e.created_at, from: e.from_email ?? '', to: e.inbox, subject: e.subject ?? '', step: null, kind: e.kind,
      body: e.body_text || e.snippet || '',
    })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

export async function POST(request: Request) {
  let user
  try {
    user = await userFromRequest(request)
  } catch (e) {
    return json({ error: `Sending isn't set up yet: ${errorMessage(e)}` }, 503)
  }
  if (!user) return json({ error: 'Sign in again to continue.' }, 401)

  let body: {
    action?: string; leadId?: string; inbox?: string; to?: string; subject?: string; body?: string; sendAt?: string; id?: number
    uid?: number; limit?: number; search?: string
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: 'Bad request' }, 400)
  }

  try {
    const settings = await loadSettings()

    if (body.action === 'thread') {
      if (!body.leadId) return json({ error: 'Missing lead' }, 400)
      const [messages, defaults] = await Promise.all([thread(body.leadId, settings), replyDefaults(body.leadId)])
      return json({ ok: true, messages, defaults, persona: defaults.inbox ? inboxPersona(defaults.inbox) : '' })
    }

    if (body.action === 'reply') {
      const { leadId, inbox, to = '', subject = '', sendAt } = body
      const text = body.body ?? ''
      if (!leadId) return json({ error: 'Missing lead' }, 400)
      if (!inbox || !(await loginInboxes([inbox])).has(inbox)) return json({ error: `${inbox ?? 'That inbox'} can't send right now.` }, 400)
      if (!EMAIL.test(to)) return json({ error: 'Enter a valid To address' }, 400)
      if (!subject.trim() || !text.trim()) return json({ error: 'Write a subject and a message' }, 400)
      if (sendAt) {
        if (!(await inboxSchema())) return json({ error: 'Run supabase/master_inbox.sql first.' }, 400)
        const when = Date.parse(sendAt)
        if (!(when > Date.now())) return json({ error: 'Pick a time in the future' }, 400)
        const { error } = await db().from('scheduled_emails').insert({ lead_id: leadId, inbox, to_email: to, subject, body: text, send_at: new Date(when).toISOString() })
        if (error) throw new Error(error.message)
        return json({ ok: true })
      }
      return json({ ok: true, ...(await sendReply({ settings, leadId, inbox, to, subject, body: text })) })
    }

    if (body.action === 'cancel-scheduled') {
      const { error } = await db().from('scheduled_emails').update({ status: 'canceled' }).eq('id', body.id ?? 0).eq('status', 'scheduled')
      if (error) throw new Error(error.message)
      return json({ ok: true })
    }

    if (body.action === 'warmup-sync') return json({ ok: true, ...(await syncWarmup(settings, true)) })

    if (body.action === 'all-mail' || body.action === 'all-mail-read') {
      const accounts = [...new Set([...settings.inboxes, ...(settings.retiredInboxes ?? [])])]
      const ready = await loginInboxes(accounts)
      if (body.action === 'all-mail') {
        const inboxes = accounts.filter(i => ready.has(i) && (!body.inbox || i === body.inbox))
        return json({ ok: true, ...(await listMail(inboxes, Math.min(500, Number(body.limit) || 50), body.search?.trim() ?? '')) })
      }
      if (!body.inbox || !ready.has(body.inbox) || !Number.isSafeInteger(body.uid)) return json({ error: 'Pick an email to read' }, 400)
      return json({ ok: true, ...(await readMail(body.inbox, body.uid!)) })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    return json({ error: errorMessage(e) }, 500)
  }
}
