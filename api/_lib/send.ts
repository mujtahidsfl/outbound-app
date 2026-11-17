// Sending one email to one lead: the shared path behind the Send button and autopilot.
import { randomUUID } from 'node:crypto'
import { resolveMx } from 'node:dns/promises'
import {
  campaignEligible, composeCampaignEmail, composeEmail, derive, footerReady, inboxCap, inboxPersona, inboxTotal, isWritten, sentByInbox,
  templateEmails, threadRoot, today, withoutOptOut,
} from '../../src/core.js'
import type { Lead, RecipientEsp, Settings, TrackMap } from '../../src/types.ts'
import { db, inboxSchema, loadAttachments, loadCampaignLead, loadLeads, loadTrack, patchSettings, saveGuard, updateTrack } from './db.js'
import { RECIPIENT_REJECTED } from './guard.js'
import { clickUrl, errorMessage, isGoogleInbox, passwordVar, pixelFor, TRACK_OPENS, unsubscribeUrl } from './env.js'
import { loginInboxes } from './google.js'
import { appendToSent, buildRaw, emailHtml, quoteHeader, quoteText, smtpSend, trackLinks, unsubscribeLine, unsubscribeText, type Quote } from './mail.js'

export type SendResult =
  | { ok: true; leadId: string; step: number; inbox: string; warning?: string }
  | { ok: false; leadId: string; error: string }

const domainOf = (email: string) => email.split('@')[1] ?? 'localhost'

export const NOT_GOOGLE = 'Skipped: not a Gmail inbox'
export const OFF_PROVIDER = 'Skipped: provider filter'
const mxCache = new Map<string, RecipientEsp>()

/** Who hosts this address's mail, from its domain and MX records: Google (with Workspace), Microsoft or anyone else. */
async function recipientEsp(email: string): Promise<RecipientEsp> {
  const d = domainOf(email).toLowerCase()
  if (d === 'gmail.com' || d === 'googlemail.com') return 'google'
  if (/^(outlook|hotmail|live|msn)\./.test(d)) return 'outlook'
  if (!mxCache.has(d)) {
    const mx = await resolveMx(d).catch(() => [])
    mxCache.set(d, mx.some(r => /(^|\.)(google|googlemail)\.com\.?$/i.test(r.exchange)) ? 'google'
      : mx.some(r => /\.(outlook|protection\.outlook|office365|hotmail)\.com\.?$/i.test(r.exchange)) ? 'outlook' : 'other')
  }
  return mxCache.get(d)!
}

/** Email 1 as a follow-up quotes it: the saved body and send time, else rebuilt from the campaign as it was written. */
export async function firstEmailQuote(o: {
  leadId: string; lead: Lead; camp: Awaited<ReturnType<typeof loadCampaignLead>>; settings: Settings; inbox: string; sentDay?: string
}): Promise<Quote | undefined> {
  const first = ((await db().from('email_messages').select('*').eq('lead_id', o.leadId).eq('step', 0).eq('status', 'sent').order('id').limit(1)).data ?? [])[0] as
    { inbox?: string; sent_at?: string; body_text?: string | null } | undefined
  const from = first?.inbox ?? o.inbox
  // Emails 1 sent before bodies were saved are rebuilt the same way they were written. The quote leaves out the old "Not a fit?" line.
  const text = withoutOptOut(first?.body_text
    ?? (o.camp ? composeCampaignEmail(o.camp.campaign, o.camp.member, o.camp.emails, 0, from).body : composeEmail(o.lead, o.settings, false, from).body))
  const sent = first?.sent_at ? new Date(first.sent_at) : o.sentDay ? new Date(`${o.sentDay}T12:00:00Z`) : undefined
  return text.trim() && sent ? { header: quoteHeader(sent, from, !!first?.sent_at), text } : undefined
}

type Claim = {
  lead_id: string; step: number; inbox: string; to_email: string; subject: string; message_id: string; source: string
  campaign_id: string | null; subject_variant: string | null; attachments: number; tracked?: boolean; body_text?: string
}

/**
 * Claim (lead, step) in email_messages before sending, so two clicks or two autopilot runs
 * can never send the same email twice. A failed earlier attempt can be reclaimed.
 */
async function claim(row: Claim) {
  const ins = await db().from('email_messages').insert({ ...row, status: 'sending' }).select('id').single()
  if (!ins.error) return ins.data.id as number
  if (ins.error.code !== '23505') throw new Error(ins.error.message)
  const retry = await db().from('email_messages')
    .update({ ...row, status: 'sending', error: null, created_at: new Date().toISOString() })
    .eq('lead_id', row.lead_id).eq('step', row.step).eq('status', 'failed')
    .select('id').maybeSingle()
  if (retry.error) throw new Error(retry.error.message)
  return retry.data ? (retry.data.id as number) : null
}

export async function sendToLead(opts: {
  leadId: string
  inbox?: string
  source: 'manual' | 'autopilot'
  settings: Settings
  tracks: TrackMap
}): Promise<SendResult> {
  const { leadId, settings, tracks, source } = opts
  const fail = (error: string): SendResult => ({ ok: false, leadId, error })
  const day = today()

  if (!footerReady(settings)) return fail('Add your company name and mailing address under Templates & settings first. Every email needs them.')

  const [lead] = await loadLeads([leadId])
  if (!lead) return fail('Lead not found')
  const camp = await loadCampaignLead(leadId, settings)
  const cfg = camp?.campaign.config ?? {}
  const track = (await loadTrack(leadId)) ?? tracks[leadId]
  const d = derive(track, camp?.campaign.cadence ?? settings.cadence, day)
  if (d.status === 'bad') return fail(`Flagged as bad data (${track?.badReason}).`)
  if (d.status === 'replied') return fail('They already replied, so the sequence is stopped.')
  if (d.status === 'done') return fail('Every follow-up has already gone out.')
  if (source === 'autopilot' && d.status === 'awaiting') return fail('Next follow-up is not due yet.')

  const step = track?.sentAt ? track.followUps.length + 1 : 0
  // A lead keeps one inbox for its whole sequence so follow-ups land in the same thread.
  let inbox = track?.inbox ?? opts.inbox
  if (!inbox) return fail('Pick which inbox to send from.')
  const to = camp?.member.toEmail || lead.email
  const esp = step === 0 && (settings.googleOnly !== false || cfg.providers?.length || cfg.espMatching) ? await recipientEsp(to) : undefined
  // A new lead goes out from a sender on the same provider, when this campaign has one with room today.
  if (esp && cfg.espMatching && !track?.inbox) {
    const sameEsp = (i: string) => (isGoogleInbox(i) ? 'google' : 'other') === esp
    const counts = sentByInbox(tracks, day)
    if (!sameEsp(inbox)) inbox = (cfg.inboxes?.length ? cfg.inboxes : settings.inboxes).find(i => sameEsp(i) && inboxTotal(counts[i]) < inboxCap(settings, i, day)) ?? inbox
  }
  if (!(await loginInboxes([inbox])).has(inbox)) return fail(`No login for ${inbox}. Click Add inbox in Mailboxes, or add ${passwordVar(inbox)} in Vercel.`)

  if (camp) {
    const { campaign: c, member } = camp
    if (c.status !== 'active' && source === 'autopilot') return fail(`Campaign "${c.name}" is paused.`)
    if (!campaignEligible(member, c)) {
      return fail(member.sendStatus === 'DO NOT SEND' ? 'Marked DO NOT SEND in the campaign.' : `${member.sendStatus}: approve this lead in the campaign first.`)
    }
    if (step > 0 && c.followUpsPaused) return fail('Follow-ups are paused for this campaign. Resume them on the campaign page.')
    if (!camp.emails[step]) return fail('Every email in the campaign has already gone out.')
    if (!camp.emails[step].body.trim()) return fail(`Email ${step + 1} of this campaign is still blank.`)
    if (c.steps[step]?.attachImages && !c.images.length) return fail(`Email ${step + 1} attaches screenshots: upload them on the campaign page first.`)
  }

  const cap = inboxCap(settings, inbox, day)
  const sentToday = inboxTotal(sentByInbox(tracks, day)[inbox])
  if (sentToday >= cap) return fail(`${inbox} already sent its ${cap} for today.`)

  // Earlier emails this app sent to the lead, to thread onto.
  const prior = step > 0
    ? ((await db().from('email_messages').select('step,message_id,subject').eq('lead_id', leadId).eq('status', 'sent').lt('step', step).order('step')).data ?? []) as { step: number; message_id: string; subject: string | null }[]
    : []

  let subject: string, body: string, variant: string | null = null, references: string[]
  let attachments: Awaited<ReturnType<typeof loadAttachments>> = []
  if (camp) {
    // Campaign emails thread only with their own thread: Email 2 starts fresh, Emails 3 and 4 answer Email 2.
    const { campaign: c, member } = camp
    let { emails } = camp
    // "Even" gives this lead whichever variant of this email has gone out least so far.
    const n = c.config.sequence?.[step]?.variants.length ?? 0
    if (isWritten(c) && c.config.variantDistribution === 'even' && n > 1) {
      const { data } = await db().from('email_messages').select('subject_variant').eq('campaign_id', c.id).eq('step', step)
      const used = new Array<number>(n).fill(0)
      for (const r of data ?? []) if (r.subject_variant) used[r.subject_variant.charCodeAt(0) - 65]++
      emails = templateEmails(c, member, settings, s => (s === step ? used.indexOf(Math.min(...used)) : undefined))
    }
    const root = threadRoot(c, step)
    const thread = prior.filter(p => threadRoot(c, p.step) === root)
    const rootSubject = prior.find(p => p.step === root)?.subject ?? undefined
    ;({ subject, body, variant } = composeCampaignEmail(c, member, emails, step, inbox, rootSubject))
    references = root === step ? [] : thread.map(p => p.message_id).filter(Boolean)
    if (c.steps[step]?.attachImages) {
      try {
        attachments = await loadAttachments(c.images)
      } catch (e) {
        return fail(errorMessage(e))
      }
    }
  } else {
    ;({ subject, body } = composeEmail(lead, settings, step > 0, inbox))
    references = prior.map(r => r.message_id).filter(Boolean)
  }
  // Outlook, Yahoo and the rest filter cold email much harder than Gmail: only Google-hosted inboxes get emailed.
  if (esp && settings.googleOnly !== false && esp !== 'google') {
    await updateTrack(leadId, t => ({ ...t, badReason: t.badReason ?? NOT_GOOGLE }))
    return fail(`${to} isn't a Gmail or Google Workspace inbox, so it was skipped.`)
  }
  if (esp && cfg.providers?.length && !cfg.providers.includes(esp)) {
    await updateTrack(leadId, t => ({ ...t, badReason: t.badReason ?? OFF_PROVIDER }))
    return fail(`${to} is outside this campaign's email providers, so it was skipped.`)
  }

  // Every follow-up quotes Email 1 underneath, like a reply would, so the lead sees what it follows up on without scrolling.
  const quote = step > 0 ? await firstEmailQuote({ leadId, lead, camp, settings, inbox, sentDay: track?.sentAt }) : undefined

  const messageId = `<${randomUUID()}@${domainOf(inbox)}>`
  // Open tracking is off (TRACK_OPENS). Plain text mode still looks like plain text: the HTML part is the same text, no signature.
  const tracked = TRACK_OPENS
  const schema = await inboxSchema()
  const trackClicks = !cfg.plainText && !!cfg.trackClicks && schema
  // Every email, every step, every campaign, ends with a hyperlinked unsubscribe line. There's no switch to turn it off.
  const unsubscribe = unsubscribeLine(leadId, cfg.unsubscribeText)
  const claimed = await claim({
    lead_id: leadId, step, inbox, to_email: to, subject, message_id: messageId, source,
    campaign_id: camp?.campaign.id ?? null, subject_variant: variant, attachments: attachments.length,
    ...(tracked ? { tracked } : {}),
    ...(schema ? { body_text: body } : {}),
  })
  if (claimed === null) return fail('This email is already sending or was already sent.')

  // The Sent-folder copy has no pixel, so reading it in webmail doesn't count as the lead opening it.
  let raw: Buffer
  const email = {
    from: inbox,
    fromName: inboxPersona(inbox),
    to,
    subject,
    text: [body, unsubscribeText(unsubscribe), quote && quoteText(quote)].filter(Boolean).join('\n\n'),
    messageId,
    inReplyTo: references[references.length - 1],
    references: references.length ? references : undefined,
    unsubscribeUrl: unsubscribeUrl(leadId),
    attachments: attachments.length ? attachments : undefined,
  }
  try {
    raw = await buildRaw(email)
    const links = trackClicks ? trackLinks(body, url => clickUrl(claimed, url)) : body
    const html = emailHtml(links, { inbox, plain: !!cfg.plainText, pixelUrl: pixelFor(claimed), unsubscribe, quote })
    await smtpSend(inbox, to, await buildRaw({ ...email, text: email.text.replace(body, () => links), html }))
  } catch (e) {
    const error = errorMessage(e)
    await db().from('email_messages').update({ status: 'failed', error }).eq('id', claimed)
    // The server said this address doesn't exist: that's a bounce. Stop the lead and count it in the bounce rate.
    if (RECIPIENT_REJECTED.test(error)) {
      await updateTrack(leadId, t => ({ ...t, badReason: t.badReason ?? 'Bounced' }))
      await db().from('email_events').upsert({
        lead_id: leadId, inbox, kind: 'bounce', from_email: to, subject, snippet: error.slice(0, 300), message_id: `smtp:${messageId}`,
        received_at: new Date().toISOString(), campaign_id: camp?.campaign.id ?? null, step,
      }, { onConflict: 'inbox,message_id', ignoreDuplicates: true })
    }
    return fail(`Send failed: ${error}`)
  }

  await db().from('email_messages').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', claimed)
  await updateTrack(leadId, t => {
    if (step === 0) return { ...t, sentAt: t.sentAt ?? day, inbox: t.inbox ?? inbox }
    if (t.followUps.length !== step - 1) return t // someone logged it by hand meanwhile
    return { ...t, sentAt: t.sentAt ?? day, inbox: t.inbox ?? inbox, followUps: [...t.followUps, day] }
  })
  // The warm-up ramp starts on the first day the app actually sends, per inbox once the guard table exists.
  if (!settings.warmupStart) {
    settings.warmupStart = day
    await patchSettings({ warmupStart: day })
  }
  if (settings.guard && !settings.guard[inbox]?.warmupStart) {
    settings.guard[inbox] = { ...settings.guard[inbox], warmupStart: day }
    await saveGuard(inbox, { warmup_start: day }).catch(() => {})
  }

  // The email is out; a failure to file it in Sent shouldn't report the send as failed.
  let warning: string | undefined
  try {
    await appendToSent(inbox, raw)
  } catch (e) {
    warning = `Sent, but not saved to the Sent folder: ${errorMessage(e)}`
    await db().from('email_messages').update({ error: warning }).eq('id', claimed)
  }
  return { ok: true, leadId, step, inbox, warning }
}
