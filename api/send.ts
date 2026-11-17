// Dashboard actions that touch the inboxes. Requires a signed-in dashboard user.
//   { action: 'send', leadId, inbox? }       send the lead's next email (first or follow-up)
//   { action: 'check-inboxes' }              log in to every inbox over SMTP and IMAP, send nothing
//   { action: 'test-email', inbox, to }      send a sample email to your own address
//   { action: 'status' }                     which inboxes have a login set up (no logins attempted)
//   { action: 'google-connect' }             the Google sign-in link behind "Add inbox" (see api/google.ts)
//   { action: 'send-due' }                   one autopilot pass right now (caps still apply)
//   { action: 'send-one', inbox, to, subject, body, leadId?, footer? }   a single hand-written email
//   { action: 'sync-replies' }               check every inbox for replies now
//   { action: 'deliverability', domain?, selector? }   SPF/DKIM/DMARC/MX for the sending domains
//   { action: 'campaign-test', campaignId, step, inbox, to, leadId? }   one campaign email (with its screenshots) to your own address
//   { action: 'seed-test' }                  run the inbox placement test now (every inbox → every seed Gmail)
//   { action: 'seed-check' }                 look up pending placement tests in the seed Gmail accounts now
import { randomUUID } from 'node:crypto'
import { composeCampaignEmail, composeEmail, emailFooter, footerReady, inboxPersona } from '../src/core.js'
import { autopilotRun } from './_lib/autopilot.js'
import { db, firstLeadOrSample, loadAttachments, loadCampaignLead, loadLeads, loadSettings, loadTracks, userFromRequest } from './_lib/db.js'
import { checkDomain } from './_lib/deliverability.js'
import { errorMessage, googleState, json, pixelFor, TRACK_OPENS } from './_lib/env.js'
import { googleSignInUrl, loginInboxes } from './_lib/google.js'
import { appendToSent, buildRaw, checkInbox, emailHtml, smtpSend, unsubscribeLine, unsubscribeText } from './_lib/mail.js'
import { sendReply } from './_lib/reply.js'
import { syncReplies } from './_lib/replies.js'
import { checkSeedTests, seedPassword, sendSeedTests } from './_lib/seed.js'
import { sendToLead } from './_lib/send.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: Request) {
  // Missing server setup (keys not added in Vercel yet) comes back as a readable error, not a crash.
  let user
  try {
    user = await userFromRequest(request)
  } catch (e) {
    return json({ error: `Sending isn't set up yet: ${errorMessage(e)}` }, 503)
  }
  if (!user) return json({ error: 'Sign in again to continue.' }, 401)

  let body: {
    action?: string; leadId?: string; inbox?: string; to?: string; subject?: string; body?: string; footer?: boolean
    domain?: string; selector?: string; campaignId?: string; step?: number
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: 'Bad request' }, 400)
  }

  try {
    const settings = await loadSettings()

    if (body.action === 'send') {
      if (!body.leadId) return json({ error: 'Missing lead' }, 400)
      const tracks = await loadTracks()
      const result = await sendToLead({ leadId: body.leadId, inbox: body.inbox, source: 'manual', settings, tracks })
      return json(result, result.ok ? 200 : 422)
    }

    if (body.action === 'check-inboxes') {
      return json({ inboxes: await Promise.all(settings.inboxes.map(checkInbox)) })
    }

    if (body.action === 'test-email') {
      const { inbox, to } = body
      const inboxes = inbox === 'all' ? settings.inboxes : inbox && settings.inboxes.includes(inbox) ? [inbox] : []
      if (!inboxes.length) return json({ error: 'Pick one of your inboxes' }, 400)
      if (!to || !EMAIL.test(to)) return json({ error: 'Enter the address to send the test to' }, 400)
      // A real lead fills the template so the test shows exactly what leads receive.
      const lead = await firstLeadOrSample()
      const results = await Promise.all(inboxes.map(async from => {
        try {
          const { subject, body: text } = composeEmail(lead, settings, false, from)
          const messageId = `<${randomUUID()}@${from.split('@')[1]}>`
          const shown = `This is a test from ${from}. Leads get the email below, filled in for their business.\n\n${text}`
          // The test's unsubscribe link is for the test address, so clicking it never opts out a real lead.
          const unsubscribe = unsubscribeLine(to)
          const raw = await buildRaw({
            from, fromName: inboxPersona(from), to, subject: `[Test] ${subject}`, text: `${shown}\n\n${unsubscribeText(unsubscribe)}`,
            html: emailHtml(shown, { inbox: from, unsubscribe }), messageId,
          })
          await smtpSend(from, to, raw)
          await db().from('email_messages').insert({
            lead_id: null, step: 0, inbox: from, to_email: to, subject: `[Test] ${subject}`, message_id: messageId,
            status: 'sent', source: 'test', sent_at: new Date().toISOString(),
          })
          let warning: string | undefined
          await appendToSent(from, raw).catch(e => { warning = `Sent, but not saved to Sent: ${errorMessage(e)}` })
          return { inbox: from, ok: true, warning }
        } catch (e) {
          return { inbox: from, ok: false, error: errorMessage(e) }
        }
      }))
      const failed = results.filter(r => !r.ok)
      return json({
        ok: failed.length === 0,
        results,
        error: failed.length ? `${failed.length} of ${results.length} failed: ${failed.map(f => `${f.inbox} (${f.error})`).join('; ')}` : undefined,
        warning: results.find(r => r.warning)?.warning,
      }, failed.length === results.length ? 502 : 200)
    }

    if (body.action === 'campaign-test') {
      const { inbox, to, campaignId } = body
      const step = Number(body.step ?? 0)
      if (!inbox || !settings.inboxes.includes(inbox)) return json({ error: 'Pick one of your inboxes' }, 400)
      if (!to || !EMAIL.test(to)) return json({ error: 'Enter the address to send the test to' }, 400)
      // The chosen lead, or the campaign's first lead, so the test is exactly what a real lead gets.
      let leadId = body.leadId
      if (!leadId) {
        const { data } = await db().from('campaign_leads').select('lead_id').eq('campaign_id', campaignId ?? '').order('position').limit(1)
        leadId = data?.[0]?.lead_id
      }
      const camp = leadId ? await loadCampaignLead(leadId) : null
      if (!camp || !camp.emails[step]) return json({ error: 'No campaign email to test' }, 400)
      const { subject, body: text } = composeCampaignEmail(camp.campaign, camp.member, camp.emails, step, inbox)
      const attachments = camp.campaign.steps[step]?.attachImages ? await loadAttachments(camp.campaign.images) : []
      const messageId = `<${randomUUID()}@${inbox.split('@')[1]}>`
      // Same unsubscribe line a lead gets, but linked to the test address, so clicking it never opts out a real lead.
      const unsubscribe = unsubscribeLine(to, camp.campaign.config?.unsubscribeText)
      const raw = await buildRaw({
        from: inbox, fromName: inboxPersona(inbox), to, subject: `[Test] ${subject}`, text: `${text}\n\n${unsubscribeText(unsubscribe)}`,
        html: emailHtml(text, { inbox, plain: !!camp.campaign.config?.plainText, unsubscribe }), messageId,
        attachments: attachments.length ? attachments : undefined,
      })
      await smtpSend(inbox, to, raw)
      await db().from('email_messages').insert({
        lead_id: null, step, inbox, to_email: to, subject: `[Test] ${subject}`, message_id: messageId,
        status: 'sent', source: 'test', sent_at: new Date().toISOString(), attachments: attachments.length,
      })
      let warning: string | undefined
      await appendToSent(inbox, raw).catch(e => { warning = `Sent, but not saved to Sent: ${errorMessage(e)}` })
      return json({ ok: true, warning, attachments: attachments.length })
    }

    if (body.action === 'status') {
      const ready = await loginInboxes(settings.inboxes)
      return json({ ok: true, passwords: Object.fromEntries(settings.inboxes.map(i => [i, ready.has(i)])) })
    }

    if (body.action === 'google-connect') {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return json({ error: "Google sign-in isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel." }, 503)
      }
      return json({ ok: true, url: googleSignInUrl(googleState()) })
    }

    if (body.action === 'send-due') return json(await autopilotRun({ manual: true }))

    if (body.action === 'seed-test') {
      const results = await sendSeedTests(settings, `manual-${new Date().toISOString()}`)
      const failed = results.filter(r => !r.ok)
      const noPass = (settings.seedInboxes ?? []).filter(s => !seedPassword(s.trim().toLowerCase()))
      return json({
        ok: failed.length < results.length,
        sent: results.length - failed.length,
        error: failed.length ? `${failed.length} of ${results.length} failed: ${failed.map(f => `${f.inbox} (${f.error})`).join('; ')}` : undefined,
        warning: noPass.length ? `Sent, but the results can't be read until SEED_PASSWORD is set in Vercel for ${noPass.join(', ')}.` : undefined,
      })
    }

    if (body.action === 'seed-check') return json({ ok: true, checked: await checkSeedTests() })

    if (body.action === 'sync-replies') return json({ ok: true, inboxes: await syncReplies() })

    if (body.action === 'deliverability') {
      const domains = body.domain ? [body.domain] : [...new Set(settings.inboxes.map(i => i.split('@')[1]).filter(Boolean))]
      return json({ domains: await Promise.all(domains.map(d => checkDomain(d, body.selector))) })
    }

    if (body.action === 'send-one') {
      const { inbox, subject = '', footer } = body
      if (!inbox || !settings.inboxes.includes(inbox)) return json({ error: 'Pick one of your inboxes' }, 400)
      if (!subject.trim() || !(body.body ?? '').trim()) return json({ error: 'Write a subject and a message' }, 400)
      let to = body.to?.trim() ?? ''
      if (body.leadId && !to) to = (await loadLeads([body.leadId]))[0]?.email ?? ''
      if (!EMAIL.test(to)) return json({ error: 'Enter a valid To address' }, 400)
      const text = footer && footerReady(settings) ? `${body.body!.trimEnd()}\n${emailFooter(settings)}` : body.body!
      // To a lead: into their thread, and a Loom link starts their Loom nudges.
      if (body.leadId) return json({ ok: true, ...(await sendReply({ settings, leadId: body.leadId, inbox, to, subject, body: text })) })
      const messageId = `<${randomUUID()}@${inbox.split('@')[1]}>`
      // Logged before it goes, so it has a row id (the open pixel used it; tracking is off now).
      const row = await db().from('email_messages').insert({
        lead_id: null, step: 0, inbox, to_email: to, subject, message_id: messageId, status: 'sending', source: 'one-off', tracked: TRACK_OPENS,
      }).select('id').single()
      if (row.error) throw new Error(row.error.message)
      const raw = await buildRaw({ from: inbox, fromName: inboxPersona(inbox), to, subject, text, messageId })
      try {
        await smtpSend(inbox, to, await buildRaw({ from: inbox, fromName: inboxPersona(inbox), to, subject, text, messageId, html: emailHtml(text, { inbox, pixelUrl: pixelFor(row.data.id) }) }))
      } catch (e) {
        await db().from('email_messages').delete().eq('id', row.data.id)
        throw e
      }
      await db().from('email_messages').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', row.data.id)
      let warning: string | undefined
      await appendToSent(inbox, raw).catch(e => { warning = `Sent, but not saved to Sent: ${errorMessage(e)}` })
      return json({ ok: true, warning })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    return json({ error: errorMessage(e) }, 500)
  }
}
