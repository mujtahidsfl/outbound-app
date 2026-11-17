// What a reply sets in motion, so nothing here needs a person: its pipeline stage, an email to you when they want the
// Loom or a call, its place in the master inbox, the company-level pause and any subsequence.
import { FREE_MAIL, isPositive, stageAfterReply, today } from '../../src/core.js'
import type { ReplyIntent, Settings, Stage } from '../../src/types.ts'
import { sortReply } from './claude.js'
import { newText } from './classify.js'
import { db, inboxSchema, loadCampaignLead, loadLeads, updateTrack } from './db.js'
import { errorMessage } from './env.js'
import { notifyMe, threadUrl } from './notify.js'
import { enroll, sendFirstNow } from './subsequence.js'

const PER_PASS = 10

export const stageStamp = (stage: Stage, at: string) => <T extends { stage?: Stage; stageLog?: Partial<Record<Stage, string>> }>(t: T): T => ({
  ...t, stage, stageLog: { ...t.stageLog, [stage]: t.stageLog?.[stage] ?? at },
})

/** A new reply or opt-out shows up unread at the top, even if the conversation was archived or snoozed. */
export async function surfaceThread(leadId: string) {
  if (!(await inboxSchema())) return
  await db().from('inbox_threads').upsert({ lead_id: leadId, unread: true, archived_at: null, snoozed_until: null, updated_at: new Date().toISOString() }, { onConflict: 'lead_id' })
}

const NOTICE: Partial<Record<ReplyIntent, string>> = {
  loom: 'wants the Loom',
  meeting: 'wants a call',
  interested: 'is interested',
}

/** Tell you about one reply, once. A failed email is retried on the next pass. */
async function notifyReply(settings: Settings, e: { id: number; lead_id: string; from_email: string | null; inbox: string; subject: string | null; body_text?: string | null; snippet: string | null; intent: ReplyIntent }) {
  const what = NOTICE[e.intent]
  if (!what || !(await inboxSchema())) return
  // Claimed first, so two passes can't both send it.
  const claim = await db().from('email_events').update({ notified_at: new Date().toISOString() }).eq('id', e.id).is('notified_at', null).select('id')
  if (!claim.data?.length) return
  const [lead] = await loadLeads([e.lead_id])
  const name = lead?.businessName || e.from_email || e.lead_id
  const said = newText(e.body_text ?? '').slice(0, 1500) || e.snippet || ''
  const steps = e.intent === 'loom'
    ? 'Record it and send it from the app or from Gmail. Either way the app sees the loom.com link, moves them to "Loom sent" and starts the nudges.'
    : 'Open the conversation to answer.'
  try {
    await notifyMe(settings, `${name} ${what}`, `${name} (${e.from_email}) ${what}.\n\nThey wrote to ${e.inbox}:\n\n${said}\n\n${steps}\n\n${threadUrl(e.lead_id)}`)
  } catch (err) {
    await db().from('email_events').update({ notified_at: null }).eq('id', e.id)
    throw err
  }
}

/** One person at a company answered: stop the rest of that campaign's leads at the same domain. */
async function pauseCompany(campaignId: string, leadId: string, email: string) {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain || FREE_MAIL.test(domain)) return
  const { data } = await db().from('campaign_leads').select('lead_id').eq('campaign_id', campaignId).ilike('to_email', `%@${domain}`).neq('lead_id', leadId).limit(50)
  for (const r of data ?? []) await updateTrack(r.lead_id, t => (t.repliedAt || t.badReason ? t : { ...t, badReason: 'Company replied' }))
}

/** Everything that follows a human reply being recorded (or re-read). */
export async function afterReply(settings: Settings, e: Parameters<typeof notifyReply>[1] & { campaign_id: string | null }) {
  const at = new Date().toISOString()
  const day = today()
  await updateTrack(e.lead_id, t => ({
    ...stageStamp(stageAfterReply(t.stage, e.intent), at)({ ...t, stageLog: { replied: at, ...t.stageLog } }),
    repliedAt: t.repliedAt ?? day,
    // "no" is the opt-out the emails offer, so it ends every future email too.
    badReason: e.intent === 'not_interested' ? t.badReason ?? 'Not interested' : t.badReason,
  }))
  await surfaceThread(e.lead_id)
  const camp = e.campaign_id ? await loadCampaignLead(e.lead_id).catch(() => null) : null
  if (camp) {
    if (camp.campaign.config.companyAutoPause && e.from_email) await pauseCompany(camp.campaign.id, e.lead_id, camp.member.toEmail || e.from_email)
    // A yes gets the after-yes email straight away, before the heads-up email to you.
    if (await enroll(camp.campaign, e.lead_id, e.intent).catch(() => false)) {
      const sent = await sendFirstNow(settings, camp.campaign, e.lead_id).catch(err => `${e.lead_id}: ${errorMessage(err)}`)
      if (sent) console.log(`after-yes: ${sent}`)
    }
  }
  await notifyReply(settings, e)
}

/** Recent positive replies whose notification hasn't gone out, because the email failed or the reply came before this ran. */
export async function pendingNotices(settings: Settings) {
  if (!(await inboxSchema())) return
  const { data } = await db().from('email_events').select('id,lead_id,from_email,inbox,subject,snippet,body_text,intent')
    .eq('kind', 'reply').in('intent', Object.keys(NOTICE)).is('notified_at', null).not('lead_id', 'is', null)
    .or('classified_by.is.null,classified_by.neq.manual').gte('created_at', new Date(Date.now() - 2 * 864e5).toISOString()).limit(PER_PASS)
  for (const e of data ?? []) await notifyReply(settings, e)
}

/**
 * Replies only the keyword rules have read (no key yet, or Claude was unreachable) get read by Claude. Their stage moves
 * only if Claude changes the answer, so a stage you set by hand stays unless the reply itself says otherwise.
 */
export async function resortReplies(settings: Settings): Promise<string[]> {
  if (!process.env.ANTHROPIC_API_KEY || !(await inboxSchema())) return []
  const { data, error } = await db().from('email_events').select('id,lead_id,from_email,inbox,subject,snippet,body_text,intent,campaign_id')
    .eq('kind', 'reply').eq('classified_by', 'rules').not('body_text', 'is', null).not('lead_id', 'is', null).order('id', { ascending: false }).limit(PER_PASS)
  if (error) return [error.message]
  const out: string[] = []
  for (const r of data ?? []) {
    try {
      const sorted = await sortReply(r.subject ?? '', r.body_text ?? '')
      if (sorted.by !== 'claude') { if (sorted.warning) out.push(sorted.warning); break }
      await db().from('email_events').update({ intent: sorted.intent, classified_by: 'claude' }).eq('id', r.id)
      if (sorted.intent !== r.intent) await afterReply(settings, { ...r, intent: sorted.intent })
      else if (isPositive(sorted.intent)) await notifyReply(settings, { ...r, intent: sorted.intent })
    } catch (e) {
      out.push(errorMessage(e))
    }
  }
  return out
}
