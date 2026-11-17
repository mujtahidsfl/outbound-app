// Answering a lead by hand, now or at a time you pick. Replies land in the lead's thread, from the inbox they wrote to.
import { randomUUID } from 'node:crypto'
import { inboxPersona } from '../../src/core.js'
import type { Settings } from '../../src/types.ts'
import { db, inboxSchema } from './db.js'
import { pixelFor, TRACK_OPENS } from './env.js'
import { hasLoomLink, loomRow, markLoomSent } from './loom.js'
import { appendToSent, buildRaw, emailHtml, smtpSend } from './mail.js'

/** Every Message-ID in a lead's conversation, oldest first, so a reply threads under all of it. */
async function threadIds(leadId: string) {
  const [sent, oneOff, back] = await Promise.all([
    db().from('email_messages').select('message_id,sent_at').eq('lead_id', leadId).eq('status', 'sent'),
    (await inboxSchema()) ? db().from('email_messages').select('message_id,sent_at').eq('thread_lead_id', leadId) : { data: [] },
    db().from('email_events').select('message_id,received_at').eq('lead_id', leadId).in('kind', ['reply', 'unsubscribe', 'auto']),
  ])
  return [
    ...[...(sent.data ?? []), ...(oneOff.data ?? [])].map(m => ({ id: m.message_id as string, at: (m.sent_at ?? '') as string })),
    ...(back.data ?? []).map(e => ({ id: e.message_id as string, at: (e.received_at ?? '') as string })),
  ].filter(x => x.id?.startsWith('<')).sort((a, b) => a.at.localeCompare(b.at)).map(x => x.id)
}

/** Who a reply goes to and from: the latest thing the lead wrote, else the latest email to them. */
export async function replyDefaults(leadId: string) {
  const [{ data: inbound }, { data: sent }] = await Promise.all([
    db().from('email_events').select('inbox,from_email,subject').eq('lead_id', leadId).in('kind', ['reply', 'unsubscribe', 'auto']).neq('inbox', '').order('received_at', { ascending: false }).limit(1),
    db().from('email_messages').select('inbox,to_email,subject').eq('lead_id', leadId).eq('status', 'sent').order('sent_at', { ascending: false }).limit(1),
  ])
  const e = inbound?.[0], m = sent?.[0]
  const base = e?.subject || m?.subject || ''
  return { inbox: (e?.inbox ?? m?.inbox ?? '') as string, to: (e?.from_email ?? m?.to_email ?? '') as string, subject: /^re:/i.test(base) ? base : `Re: ${base}` }
}

export async function sendReply(o: { settings: Settings; leadId: string; inbox: string; to: string; subject: string; body: string }) {
  const { leadId, inbox, to, subject, body } = o
  const ids = await threadIds(leadId)
  const messageId = `<${randomUUID()}@${inbox.split('@')[1]}>`
  const schema = await inboxSchema()
  // Logged before it goes, so it has a row id (the open pixel used it; tracking is off now).
  // A Loom link moves them to "Loom sent" and starts the nudges; anything else is one more email in the thread.
  const loom = hasLoomLink(body)
  const claim = { status: 'sending', tracked: TRACK_OPENS }
  const rowId = loom
    ? await loomRow(leadId, { inbox, to, subject, messageId, body }, claim)
    : (await db().from('email_messages').insert({
      lead_id: null, step: 0, inbox, to_email: to, subject, message_id: messageId, source: 'one-off', ...claim,
      ...(schema ? { thread_lead_id: leadId, body_text: body } : {}),
    }).select('id').single()).data?.id as number | undefined ?? null
  // The Sent-folder copy has no pixel, so reading it in webmail doesn't count as the lead opening it.
  const raw = await buildRaw({
    from: inbox, fromName: inboxPersona(inbox), to, subject, text: body, messageId,
    inReplyTo: ids[ids.length - 1], references: ids.length ? ids : undefined,
  })
  try {
    await smtpSend(inbox, to, await buildRaw({
      from: inbox, fromName: inboxPersona(inbox), to, subject, text: body, messageId,
      html: emailHtml(body, { inbox, pixelUrl: rowId ? pixelFor(rowId) : undefined }),
      inReplyTo: ids[ids.length - 1], references: ids.length ? ids : undefined,
    }))
  } catch (e) {
    if (rowId) await db().from('email_messages').delete().eq('id', rowId)
    throw e
  }
  const sentAt = new Date().toISOString()
  if (rowId) await db().from('email_messages').update({ status: 'sent', sent_at: sentAt }).eq('id', rowId)
  if (loom) await markLoomSent(leadId, sentAt)
  if (schema) await db().from('inbox_threads').upsert({ lead_id: leadId, unread: false, updated_at: sentAt }, { onConflict: 'lead_id' })
  let warning: string | undefined
  await appendToSent(inbox, raw).catch(e => { warning = `Sent, but not saved to Sent: ${e instanceof Error ? e.message : e}` })
  return { warning }
}

/** Replies scheduled for now, then reminders that came due (back on top of the inbox; emailed in the end-of-day digest). Runs every 5 minutes, whether or not sending is on. */
export async function runInboxTimers(settings: Settings): Promise<string[]> {
  if (!(await inboxSchema())) return []
  const now = new Date().toISOString()
  const out: string[] = []
  const { data: due } = await db().from('scheduled_emails').select('id,lead_id,inbox,to_email,subject,body').eq('status', 'scheduled').lte('send_at', now).limit(10)
  for (const s of due ?? []) {
    // Claimed first, so two passes can't both send it.
    const claim = await db().from('scheduled_emails').update({ status: 'sending' }).eq('id', s.id).eq('status', 'scheduled').select('id')
    if (!claim.data?.length) continue
    try {
      await sendReply({ settings, leadId: s.lead_id, inbox: s.inbox, to: s.to_email, subject: s.subject, body: s.body })
      await db().from('scheduled_emails').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', s.id)
      out.push(`scheduled reply sent to ${s.to_email}`)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await db().from('scheduled_emails').update({ status: 'failed', error }).eq('id', s.id)
      out.push(`scheduled reply failed: ${error}`)
    }
  }
  const { data: reminders } = await db().from('inbox_threads').select('lead_id,remind_note').lte('remind_at', now).is('reminded_at', null).limit(20)
  for (const r of reminders ?? []) {
    await db().from('inbox_threads').update({ reminded_at: now, unread: true, archived_at: null, snoozed_until: null }).eq('lead_id', r.lead_id)
    out.push(`reminder: ${r.lead_id}`)
  }
  return out
}
