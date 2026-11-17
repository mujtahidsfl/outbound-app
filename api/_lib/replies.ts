// Reply sync: reads each inbox over IMAP, matches new mail to leads, and records replies, opt-outs and bounces.
import { simpleParser } from 'mailparser'
import { today } from '../../src/core.js'
import { classify, classifyIntent, newText, parseHeaders, referencedIds, type InboundKind } from './classify.js'
import { sortReply } from './claude.js'
import { db, inboxSchema, leadIdByCampaignEmail, loadSettings, loadTrack, updateTrack } from './db.js'
import { errorMessage } from './env.js'
import { loginInboxes } from './google.js'
import { conversations, loomWaiting, recordSentByHand, sentByHand } from './loom.js'
import { imapClient } from './mail.js'
import { afterReply, pendingNotices, resortReplies, stageStamp, surfaceThread } from './pipeline.js'
import type { Settings } from '../../src/types.ts'

const FIRST_RUN_DAYS = 14
const MAX_SOURCE = 256_000
// Replies recorded before full bodies were kept, filled in a few at a time.
const BACKFILL_PER_RUN = 20
const HEADER_NAMES = ['in-reply-to', 'references', 'auto-submitted', 'x-autoreply', 'x-autorespond', 'x-failed-recipients']

type Found = Record<InboundKind | 'unmatched' | 'checked' | 'loomsSent', number>

/** p, or a rejection after ms. The work behind p isn't cancelled; this only stops waiting for it. */
export function within<T>(ms: number, why: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(why)), ms) })]).finally(() => clearTimeout(timer))
}

export async function syncReplies() {
  const settings = await loadSettings()
  // Retired inboxes send nothing, but leads can still answer what they sent.
  const all = [...new Set([...settings.inboxes, ...(settings.retiredInboxes ?? [])])]
  const ours = new Set(all.map(i => i.toLowerCase()))
  const domains = [...new Set(all.map(i => i.split('@')[1]).filter(Boolean))]
  const ready = await loginInboxes(all)
  const inboxes = all.filter(i => ready.has(i))
  const people = await conversations()
  // One inbox that hangs (a stuck IMAP login) must not hold up the rest: each gets 25 seconds, and whatever it saved stays saved.
  const results = await Promise.allSettled(inboxes.map(i => within(25_000, `${i} took over 25s`, syncInbox(i, ours, domains, people, settings))))
  await within(15_000, 'resort took over 15s', Promise.all([resortReplies(settings), pendingNotices(settings)])).catch(() => {})
  return Object.fromEntries(inboxes.map((inbox, k) => {
    const r = results[k]
    return [inbox, r.status === 'fulfilled' ? r.value : { error: errorMessage(r.reason) }]
  }))
}

async function syncInbox(inbox: string, ours: Set<string>, domains: string[], people: Map<string, string>, settings: Settings): Promise<Found> {
  const found: Found = { checked: 0, reply: 0, unsubscribe: 0, auto: 0, bounce: 0, unmatched: 0, loomsSent: 0 }
  const { data: state } = await db().from('inbox_state').select('last_uid,uid_validity').eq('inbox', inbox).maybeSingle()

  const failed = async (e: unknown) => {
    await db().from('inbox_state').upsert({ inbox, checked_at: new Date().toISOString(), error: errorMessage(e) })
    throw e
  }
  const client = await imapClient(inbox).catch(failed)
  let uidValidity = ''
  let lastUid = 0
  let messages: Awaited<ReturnType<typeof client.fetchAll>> = []
  let byHand: Awaited<ReturnType<typeof sentByHand>> = []
  const schema = await inboxSchema()
  const missing = schema ? await missingBodies(inbox) : []
  const filled: { id: number; text: string }[] = []
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      if (!client.mailbox) throw new Error('Could not open INBOX')
      uidValidity = String(client.mailbox.uidValidity)
      const fresh = !state || state.uid_validity !== uidValidity
      lastUid = fresh ? 0 : Number(state.last_uid)
      const range = fresh
        ? (await client.search({ since: new Date(Date.now() - FIRST_RUN_DAYS * 864e5) }, { uid: true })) || []
        : `${lastUid + 1}:*`
      if (typeof range === 'string' || range.length) {
        messages = await client.fetchAll(range, { uid: true, envelope: true, headers: HEADER_NAMES, source: { maxLength: MAX_SOURCE } }, { uid: true })
      }
      for (const m of missing) {
        const text = await findBody(client, m.message_id)
        if (text) filled.push({ id: m.id, text })
      }
    } finally {
      lock.release()
    }
    // What you wrote from Gmail itself. A Loom in there starts the Loom nudges (see loom.ts).
    byHand = await sentByHand(client, people).catch(() => [])
  } catch (e) {
    await failed(e)
  } finally {
    await client.logout().catch(() => {})
  }

  let maxUid = lastUid
  for (const msg of messages) {
    if (msg.uid <= lastUid) continue // "n:*" returns the newest message even when nothing is new
    maxUid = Math.max(maxUid, msg.uid)
    found.checked++
    const kind = await handleMessage(inbox, uidValidity, msg, ours, domains, settings)
    found[kind]++
  }
  for (const f of filled) await db().from('email_events').update({ body_text: f.text }).eq('id', f.id)
  // After the replies above, so a lead who just asked for the Loom is already "Wants Loom".
  if (byHand.length) found.loomsSent = await recordSentByHand(inbox, byHand, await loomWaiting())

  await db().from('inbox_state').upsert({
    inbox, last_uid: maxUid, uid_validity: uidValidity, checked_at: new Date().toISOString(), error: null,
  })
  return found
}

/** Replies from before full bodies were stored. Rows that came from a thrown error or a link have no real Message-ID. */
async function missingBodies(inbox: string) {
  const { data } = await db().from('email_events').select('id,message_id').eq('inbox', inbox).in('kind', ['reply', 'unsubscribe', 'auto'])
    .is('body_text', null).like('message_id', '<%').order('id', { ascending: false }).limit(BACKFILL_PER_RUN)
  return (data ?? []) as { id: number; message_id: string }[]
}

/** The text of one message in the open mailbox, by Message-ID. */
async function findBody(client: Awaited<ReturnType<typeof imapClient>>, messageId: string) {
  const uids = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || []
  if (!uids.length) return ''
  const msg = await client.fetchOne(String(uids[0]), { source: { maxLength: MAX_SOURCE } }, { uid: true })
  return msg && msg.source ? (await simpleParser(msg.source).catch(() => null))?.text ?? '' : ''
}

async function handleMessage(
  inbox: string,
  uidValidity: string,
  msg: { uid: number; envelope?: { from?: { address?: string }[]; subject?: string; messageId?: string; inReplyTo?: string; date?: Date | string }; headers?: Buffer; source?: Buffer },
  ours: Set<string>,
  domains: string[],
  settings: Settings,
): Promise<InboundKind | 'unmatched'> {
  const from = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? ''
  if (ours.has(from)) return 'unmatched'
  const headers = parseHeaders(msg.headers?.toString('utf8') ?? '')
  if (msg.envelope?.inReplyTo && !headers['in-reply-to']) headers['in-reply-to'] = msg.envelope.inReplyTo
  let text = ''
  if (msg.source) {
    try {
      text = (await simpleParser(msg.source)).text ?? ''
    } catch {
      text = msg.source.toString('utf8') // truncated or odd MIME: search the raw text instead
    }
  }
  const inbound = { from, subject: msg.envelope?.subject ?? '', text, headers }
  const kind = classify(inbound)

  // Match to a lead: by the thread first, then (bounces) the failed address, then (replies) the sender.
  // The thread also says which email they answered.
  let leadId: string | undefined
  let step: number | undefined
  let campaignId: string | null = null
  const ids = referencedIds(inbound, domains)
  if (ids.length) {
    const { data } = await db().from('email_messages').select('lead_id,step,campaign_id').in('message_id', ids).not('lead_id', 'is', null).order('step', { ascending: false }).limit(1)
    leadId = data?.[0]?.lead_id ?? undefined
    step = data?.[0]?.step ?? undefined
    campaignId = data?.[0]?.campaign_id ?? null
  }
  if (!leadId && kind === 'bounce' && headers['x-failed-recipients']) {
    const failed = headers['x-failed-recipients'].split(',')[0].trim().toLowerCase()
    leadId = (await leadIdByCampaignEmail(failed)) ?? failed
  }
  if (!leadId && kind !== 'bounce') leadId = (await leadIdByCampaignEmail(from)) ?? from // lead ids are the lowercased email address
  const track = leadId ? await loadTrack(leadId) : undefined
  if (!leadId || !track?.sentAt) return 'unmatched'

  const receivedAt = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : new Date().toISOString()
  if (step === undefined || !campaignId) {
    // Not matched through the thread: credit the latest email sent before this arrived.
    const { data } = await db().from('email_messages').select('step,campaign_id').eq('lead_id', leadId).eq('status', 'sent')
      .lte('sent_at', receivedAt).order('step', { ascending: false }).limit(1)
    step ??= data?.[0]?.step ?? undefined
    campaignId ??= data?.[0]?.campaign_id ?? null
  }
  // The keyword rules first, so the reply is on record even if Claude is slow; Claude's answer replaces this below.
  const intent = kind === 'reply' ? classifyIntent(text) : null
  const schema = await inboxSchema()

  const inserted = await db().from('email_events').upsert({
    lead_id: leadId,
    inbox,
    kind,
    from_email: from,
    subject: inbound.subject.slice(0, 300),
    snippet: newText(text).slice(0, 300),
    message_id: msg.envelope?.messageId || `uid:${uidValidity}:${msg.uid}`,
    received_at: receivedAt,
    step: step ?? null,
    campaign_id: campaignId,
    intent,
    ...(schema ? { body_text: text, classified_by: intent ? 'rules' : null } : {}),
  }, { onConflict: 'inbox,message_id', ignoreDuplicates: true }).select('id')
  if (inserted.error) throw new Error(inserted.error.message)
  if (!inserted.data.length) return kind // already handled on an earlier run

  const day = today()
  const at = new Date().toISOString()
  if (kind === 'reply') {
    const sorted = schema ? await sortReply(inbound.subject, text) : { intent: intent!, by: 'rules' as const }
    if (sorted.by === 'claude') await db().from('email_events').update({ intent: sorted.intent, classified_by: 'claude' }).eq('id', inserted.data[0].id)
    await afterReply(settings, {
      id: inserted.data[0].id, lead_id: leadId, from_email: from, inbox, subject: inbound.subject, snippet: newText(text).slice(0, 300),
      body_text: text, intent: sorted.intent, campaign_id: campaignId,
    }).catch(() => {}) // a failed notification is retried by pendingNotices
  }
  if (kind === 'unsubscribe') {
    await updateTrack(leadId, t => ({ ...stageStamp('not_interested', at)(t), repliedAt: t.repliedAt ?? day, badReason: t.badReason ?? 'Unsubscribed' }))
    await surfaceThread(leadId)
  }
  if (kind === 'bounce') await updateTrack(leadId, t => ({ ...t, badReason: t.badReason ?? 'Bounced' }))
  return kind
}
