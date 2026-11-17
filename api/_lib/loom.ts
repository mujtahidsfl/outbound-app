// Loom follow-ups. A lead who asks for the video ("loom", "video", "send it") stops getting the sequence and shows as
// "Wants Loom". The Loom email itself is always written by hand, from Gmail or from this app. Once it's out (an email
// with a loom.com link to that lead, or the stage set to "Loom sent" by hand), autopilot nudges them in the same
// thread from the same inbox: 3 short emails, 2, 3 and 3 days apart, weekdays only. The nudges stop as soon as the
// lead writes back, opts out or bounces, or their stage moves on (call booked, won, lost...).
// The Loom email is recorded as email_messages step 100 and the nudges as 101-103, so each goes out once.
import { randomUUID } from 'node:crypto'
import type { ImapFlow } from 'imapflow'
import { TIME_ZONE, TRACKING_COLUMNS, addDays, companyLine, fromRow, inboxPersona, today, type TrackingRow } from '../../src/core.js'
import type { Settings } from '../../src/types.ts'
import { db, inboxSchema, loadCampaignLead, loadLeads, loadTrack, updateTrack } from './db.js'
import { simpleParser } from 'mailparser'
import { errorMessage, pixelFor, TRACK_OPENS, unsubscribeUrl } from './env.js'
import { loginInboxes } from './google.js'
import { appendToSent, buildRaw, emailHtml, smtpSend, unsubscribeLine, unsubscribeText } from './mail.js'

export const LOOM_STEP = 100
const GAPS = [2, 3, 3]
const SENT_LOOKBACK_DAYS = 7

export const LOOM_NUDGES = [
  `Hi {first},

Just checking the video I sent over came through okay. Sometimes the link gets blocked or won't load, so if it didn't play on your end, let me know and I'll send it another way.

If a quick call is easier, that works too. Reply with a day and time, or your number, and I'll call you.`,
  `Hi {first},

Did you get a chance to watch the video? If anything in it doesn't fit how {biz} works, tell me what you'd change and I'll set it up that way.

If it's not a priority right now, that's fine too. Just let me know either way.`,
  `Hi {first},

Last note from me on this. It's all set up for {biz}, and it doesn't cost you anything unless it brings you business.

Want me to get it going, or should I close this out?`,
]

export const hasLoomLink = (text: string) => /loom\.com\//i.test(text)

const etDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TIME_ZONE })
/** `days` after `day`, moved on to Monday if it lands on a weekend (nothing sends then). */
function weekdayAfter(day: string, days: number) {
  const d = addDays(day, days)
  const w = new Date(`${d}T12:00:00Z`).getUTCDay()
  return w === 6 ? addDays(d, 2) : w === 0 ? addDays(d, 1) : d
}

/** Day the next nudge is due: GAPS[n] weekdays-ish after the Loom (n = 0) or after the previous nudge. */
export const nudgeDue = (prevAt: string, n: number) => weekdayAfter(etDay(prevAt), GAPS[n])

/** Leads who could be sent a Loom: they replied ("Wants Loom", or a reply the sorter didn't read as a Loom request). */
export async function loomWaiting(): Promise<Set<string>> {
  const { data, error } = await db().from('lead_tracking').select('lead_id').in('stage', ['replied', 'loom_requested'])
  if (error) throw new Error(error.message)
  return new Set((data ?? []).map(r => r.lead_id as string))
}

/** A Loom went out to a lead who replied: move them to "Loom sent", which starts the nudges. */
export async function markLoomSent(leadId: string, at: string) {
  const t = await loadTrack(leadId)
  if (!t?.repliedAt || (t.stage && t.stage !== 'replied' && t.stage !== 'loom_requested')) return false
  await updateTrack(leadId, x => ({ ...x, stage: 'loom_sent', stageLog: { ...x.stageLog, loom_sent: x.stageLog?.loom_sent ?? at } }))
  return true
}

/** Record a hand-written Loom email as the lead's step 100 (the nudges thread onto it) and mark them "Loom sent". */
export async function recordLoom(leadId: string, m: { inbox: string; to: string; subject: string; messageId: string; sentAt: string; body?: string }) {
  await loomRow(leadId, m, { status: 'sent', sent_at: m.sentAt })
  return markLoomSent(leadId, m.sentAt)
}

/**
 * The email_messages row for a Loom: step 100, or a plain one-off if the lead already has a Loom on record.
 * The app's own sends claim it as 'sending' with `tracked` first, so the email can carry its own open pixel. Returns the row id.
 */
export async function loomRow(leadId: string, m: { inbox: string; to: string; subject: string; messageId: string; body?: string }, extra: Record<string, unknown>) {
  const full = (await inboxSchema()) ? { body_text: m.body ?? null } : {}
  const ins = await db().from('email_messages').insert({
    lead_id: leadId, step: LOOM_STEP, inbox: m.inbox, to_email: m.to, subject: m.subject, message_id: m.messageId,
    source: 'one-off', campaign_id: null, ...full, ...extra,
  }).select('id').single()
  if (ins.error && ins.error.code !== '23505') throw new Error(ins.error.message)
  if (!ins.error) return ins.data.id as number
  // A no-op if it's the same message.
  const again = await db().from('email_messages').insert({
    lead_id: null, step: 0, inbox: m.inbox, to_email: m.to, subject: m.subject, message_id: m.messageId, source: 'one-off',
    ...('body_text' in full ? { ...full, thread_lead_id: leadId } : {}), ...extra,
  }).select('id').single()
  return (again.data?.id as number | undefined) ?? null
}

/** Who has written back, by every address they wrote from: their own mail from us counts as part of a conversation. */
export async function conversations() {
  const { data, error } = await db().from('email_events').select('lead_id,from_email').eq('kind', 'reply').not('lead_id', 'is', null)
  if (error) throw new Error(error.message)
  const byAddress = new Map<string, string>()
  for (const r of data ?? []) {
    byAddress.set(r.lead_id as string, r.lead_id as string)
    if (r.from_email) byAddress.set((r.from_email as string).toLowerCase(), r.lead_id as string)
  }
  return byAddress
}

export type SentByHand = { leadId: string; to: string; subject: string; messageId: string; sentAt: string; text: string; loom: boolean }

/**
 * Mail you wrote from the inbox itself to people in a conversation, from the last week of its Sent folder, skipping
 * anything this app already has on record. Call with the client connected; leaves no mailbox open.
 */
export async function sentByHand(client: ImapFlow, people: Map<string, string>): Promise<SentByHand[]> {
  if (!people.size) return []
  const folders = await client.list()
  const sent = folders.find(f => f.specialUse === '\\Sent') ?? folders.find(f => /^(\[gmail\]\/)?sent( mail| items| messages)?$/i.test(f.path))
  if (!sent) return []
  const lock = await client.getMailboxLock(sent.path)
  try {
    const uids = (await client.search({ since: new Date(Date.now() - SENT_LOOKBACK_DAYS * 864e5) }, { uid: true })) || []
    if (!uids.length) return []
    const heads = (await client.fetchAll(uids, { uid: true, envelope: true }, { uid: true })).flatMap(m => {
      const e = m.envelope
      const to = (e?.to ?? []).map(a => a.address?.toLowerCase()).find((a): a is string => !!a && people.has(a))
      return e?.messageId && to ? [{ uid: m.uid, to, subject: e.subject ?? '', messageId: e.messageId, sentAt: new Date(e.date ?? Date.now()).toISOString() }] : []
    })
    if (!heads.length) return []
    const { data: known } = await db().from('email_messages').select('message_id').in('message_id', heads.map(h => h.messageId))
    const seen = new Set((known ?? []).map(k => k.message_id as string))
    const out: SentByHand[] = []
    for (const h of heads) {
      if (seen.has(h.messageId)) continue
      const msg = await client.fetchOne(String(h.uid), { source: { maxLength: 256_000 } }, { uid: true })
      const parsed = msg && msg.source ? await simpleParser(msg.source).catch(() => null) : null
      const text = parsed?.text ?? ''
      out.push({ ...h, leadId: people.get(h.to)!, text, loom: hasLoomLink(`${text} ${parsed?.html || ''}`) })
    }
    return out
  } finally {
    lock.release()
  }
}

/** File what you sent from Gmail in its conversation. A Loom moves a lead who asked to "Loom sent" and starts the nudges. */
export async function recordSentByHand(inbox: string, found: SentByHand[], waiting: Set<string>) {
  const schema = await inboxSchema()
  let looms = 0
  for (const m of found) {
    if (m.loom && waiting.has(m.leadId)) {
      if (await recordLoom(m.leadId, { inbox, to: m.to, subject: m.subject, messageId: m.messageId, sentAt: m.sentAt, body: m.text })) {
        waiting.delete(m.leadId)
        looms++
      }
    } else if (schema) {
      await db().from('email_messages').insert({
        lead_id: null, step: 0, inbox, to_email: m.to, subject: m.subject, message_id: m.messageId, status: 'sent', source: 'gmail',
        sent_at: m.sentAt, thread_lead_id: m.leadId, body_text: m.text,
      })
    }
    if (schema) await db().from('inbox_threads').upsert({ lead_id: m.leadId, unread: false, updated_at: m.sentAt }, { onConflict: 'lead_id' })
  }
  return looms
}

type Msg = { step: number; inbox: string; to_email: string; subject: string | null; message_id: string | null; sent_at: string | null; status: string }

/** Send every Loom nudge that's due. Call only inside the send window. */
export async function runLoomNudges(settings: Settings): Promise<string[]> {
  const { data, error } = await db().from('lead_tracking').select(TRACKING_COLUMNS).eq('stage', 'loom_sent')
  if (error) throw new Error(error.message)
  const out: string[] = []
  const day = today()
  for (const row of data as unknown as TrackingRow[]) {
    const leadId = row.lead_id
    const t = fromRow(row)
    if (t.badReason) continue
    const { data: msgs, error: mErr } = await db().from('email_messages').select('step,inbox,to_email,subject,message_id,sent_at,status')
      .eq('lead_id', leadId).order('step')
    if (mErr) { out.push(`${leadId}: ${mErr.message}`); continue }
    const all = (msgs ?? []) as Msg[]
    const loom = all.find(m => m.step === LOOM_STEP && m.status === 'sent')
    const nudges = all.filter(m => m.step > LOOM_STEP)
    const n = nudges.length
    if (n >= LOOM_NUDGES.length) continue
    if (nudges.some(m => m.status !== 'sent')) { out.push(`${leadId}: nudge ${n} is still sending`); continue }

    const loomAt = loom?.sent_at ?? t.stageLog?.loom_sent
    if (!loomAt) continue
    const prevAt = nudges[n - 1]?.sent_at ?? loomAt
    if (nudgeDue(prevAt, n) > day) continue

    // Anything back from them since the Loom (a reply, an opt-out, a bounce) ends the nudges.
    const { data: back } = await db().from('email_events').select('kind,received_at,message_id').eq('lead_id', leadId)
      .in('kind', ['reply', 'unsubscribe', 'bounce']).order('received_at')
    if ((back ?? []).some(e => Date.parse(e.received_at) > Date.parse(loomAt))) continue

    const sent = all.filter(m => m.status === 'sent' && m.sent_at).sort((a, b) => Date.parse(a.sent_at!) - Date.parse(b.sent_at!))
    const last = sent[sent.length - 1]
    const inbox = [loom?.inbox, last?.inbox, t.inbox].find((i): i is string => !!i && settings.inboxes.includes(i))
    if (!inbox) { out.push(`${leadId}: Loom nudges wait, no live inbox wrote to them`); continue }
    if (!(await loginInboxes([inbox])).has(inbox)) { out.push(`${leadId}: waiting, ${inbox} has no login`); continue }

    const thread = [
      ...sent.map(m => ({ id: m.message_id, at: m.sent_at! })),
      ...(back ?? []).filter(e => e.kind === 'reply').map(e => ({ id: e.message_id as string, at: e.received_at as string })),
    ].filter((x): x is { id: string; at: string } => !!x.id && x.id.startsWith('<')).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(x => x.id)
    const base = loom?.subject || last?.subject || ''
    const subject = /^re:/i.test(base) ? base : `Re: ${base}`
    const to = loom?.to_email || last?.to_email || leadId
    out.push(`${leadId}: ${await sendNudge({ leadId, inbox, to, subject, n, thread, settings })}`)
  }
  return out
}

/** Everything needed to carry on a lead's thread, and whether they've answered since `since`. */
export async function threadOf(leadId: string, since: string) {
  const [{ data: msgs }, { data: back }] = await Promise.all([
    db().from('email_messages').select('step,inbox,to_email,subject,message_id,sent_at,status').eq('lead_id', leadId).eq('status', 'sent').order('sent_at'),
    db().from('email_events').select('kind,received_at,message_id').eq('lead_id', leadId).in('kind', ['reply', 'unsubscribe', 'bounce']).order('received_at'),
  ])
  const sent = ((msgs ?? []) as Msg[]).filter(m => m.sent_at)
  const last = sent[sent.length - 1]
  const ids = [
    ...sent.map(m => ({ id: m.message_id, at: m.sent_at! })),
    ...(back ?? []).filter(e => e.kind === 'reply').map(e => ({ id: e.message_id as string, at: e.received_at as string })),
  ].filter((x): x is { id: string; at: string } => !!x.id && x.id.startsWith('<')).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(x => x.id)
  const base = last?.subject ?? ''
  return {
    inbox: last?.inbox, to: last?.to_email ?? leadId, subject: /^re:/i.test(base) ? base : `Re: ${base}`, ids,
    answered: (back ?? []).some(e => Date.parse(e.received_at) > Date.parse(since)),
  }
}

async function sendNudge(o: { leadId: string; inbox: string; to: string; subject: string; n: number; thread: string[]; settings: Settings }) {
  const { leadId, inbox, to, subject, n, thread, settings } = o
  const camp = await loadCampaignLead(leadId, settings)
  const lead = camp ? undefined : (await loadLeads([leadId]))[0]
  // The greeting the sequence used ("Hi Lloyd,"), so the nudges sound like the same person.
  const first = /^Hi ([^,\n]+),/.exec(camp?.emails[0]?.body ?? '')?.[1]
  const biz = camp?.member.shortName || camp?.member.businessName || lead?.businessName || 'your business'
  const sign = `${inboxPersona(inbox)}\n${companyLine(settings)}`
  const body = `${LOOM_NUDGES[n].replace(first ? '{first}' : ' {first}', first ?? '').replaceAll('{biz}', biz)}\n\n${sign}`
  return sendThreaded({ leadId, inbox, to, subject, body, step: LOOM_STEP + 1 + n, ids: thread, settings, label: `Loom nudge ${n + 1}` })
}

/** One automatic email in a lead's thread, claimed on (lead, step) so it goes out once. */
export async function sendThreaded(o: { leadId: string; inbox: string; to: string; subject: string; body: string; step: number; ids: string[]; settings: Settings; label: string }) {
  const { leadId, inbox, to, subject, body, step, ids, label } = o
  const messageId = `<${randomUUID()}@${inbox.split('@')[1]}>`
  const ins = await db().from('email_messages').insert({
    lead_id: leadId, step, inbox, to_email: to, subject, message_id: messageId,
    status: 'sending', source: 'autopilot', campaign_id: null, tracked: TRACK_OPENS, ...((await inboxSchema()) ? { body_text: body } : {}),
  }).select('id').single()
  if (ins.error) return ins.error.code === '23505' ? 'already sending or sent' : `claim failed: ${ins.error.message}`
  const rowId = ins.data.id as number

  // Automatic emails end with the hyperlinked unsubscribe line, like every campaign email.
  const unsubscribe = unsubscribeLine(leadId)
  const email = {
    from: inbox, fromName: inboxPersona(inbox), to, subject, text: `${body}\n\n${unsubscribeText(unsubscribe)}`, messageId,
    inReplyTo: ids[ids.length - 1], references: ids.length ? ids : undefined, unsubscribeUrl: unsubscribeUrl(leadId),
  }
  let raw: Buffer
  try {
    raw = await buildRaw(email)
    await smtpSend(inbox, to, await buildRaw({ ...email, html: emailHtml(body, { inbox, pixelUrl: pixelFor(rowId), unsubscribe }) }))
  } catch (e) {
    // Drop the claim so the next pass retries it.
    await db().from('email_messages').delete().eq('id', rowId)
    return `${label} failed: ${errorMessage(e)}`
  }
  await db().from('email_messages').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', rowId)
  await appendToSent(inbox, raw).catch(() => {})
  return `${label} sent`
}
