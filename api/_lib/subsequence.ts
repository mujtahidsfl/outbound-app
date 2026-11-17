// Conditional follow-ups. A campaign can hold short sequences that start when a lead's reply lands in a category, or when
// they finish the sequence, open or click without replying. Each email goes out in the lead's thread from the same inbox.
// Their emails are email_messages steps 200+, so each goes out once. Anything back from the lead ends the run.
import { addDays, companyLine, derive, fillVars, fromRow, inboxPersona, leadVars, today, TRACKING_COLUMNS, type TrackingRow } from '../../src/core.js'
import type { Campaign, ReplyIntent, Settings, Subsequence, SubsequenceTrigger, Track } from '../../src/types.ts'
import { db, inboxSchema, loadCampaignLead, loadMembers } from './db.js'
import { errorMessage } from './env.js'
import { sendThreaded, threadOf } from './loom.js'

export const SUB_STEP = 200
const etDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const match = (c: Campaign, trigger: SubsequenceTrigger): Subsequence | undefined =>
  c.config.subsequences?.find(s => s.enabled && s.trigger === trigger && s.steps.length)

async function start(c: Campaign, leadId: string, sub: Subsequence) {
  await db().from('subsequence_runs').upsert({ lead_id: leadId, campaign_id: c.id, subsequence_id: sub.id }, { onConflict: 'lead_id', ignoreDuplicates: true })
}

/**
 * A sorted reply may start a subsequence. "no" never does. A Loom request or a call request only starts the "interested"
 * track (when there is one and nothing for that category), since the after-yes emails answer "send the video" and
 * "let's talk" too. Without one, a Loom request keeps its own path. Returns whether a run started.
 */
export async function enroll(c: Campaign, leadId: string, intent: ReplyIntent): Promise<boolean> {
  if (intent === 'not_interested' || !(await inboxSchema())) return false
  const sub = (intent === 'loom' ? undefined : match(c, intent)) ?? (intent === 'loom' || intent === 'meeting' ? match(c, 'interested') : undefined)
  if (!sub) return false
  await start(c, leadId, sub)
  return true
}

/** Leads the main sequence must leave alone: in a subsequence, or stopped by a campaign's open or click rule. */
export async function stoppedLeads(campaigns: Campaign[]) {
  const out = new Set<string>()
  if (!(await inboxSchema())) return out
  const runs = await db().from('subsequence_runs').select('lead_id')
  for (const r of runs.data ?? []) out.add(r.lead_id)
  for (const c of campaigns) {
    if (!c.config.stopOnOpen && !c.config.stopOnClick) continue
    const on = [c.config.stopOnOpen && 'opened_at.not.is.null', c.config.stopOnClick && 'clicked_at.not.is.null'].filter(Boolean).join(',')
    const { data } = await db().from('email_messages').select('lead_id').eq('campaign_id', c.id).or(on)
    for (const m of data ?? []) if (m.lead_id) out.add(m.lead_id)
  }
  return out
}

/** Start the runs that depend on what a lead did rather than a reply. */
async function enrollBehavior(campaigns: Campaign[], tracks: Map<string, Track>) {
  const watching = campaigns.filter(c => match(c, 'finished') || match(c, 'opened') || match(c, 'clicked'))
  if (!watching.length) return
  const ids = new Set(watching.map(c => c.id))
  const members = (await loadMembers()).filter(m => ids.has(m.campaignId))
  const seen = new Set((await db().from('subsequence_runs').select('lead_id')).data?.map(r => r.lead_id))
  const day = today()
  for (const c of watching) {
    const mine = members.filter(m => m.campaignId === c.id && !seen.has(m.leadId))
    const finished = match(c, 'finished')
    if (finished) {
      for (const m of mine) {
        const t = tracks.get(m.leadId)
        if (t && derive(t, c.cadence, day).status === 'done') { await start(c, m.leadId, finished); seen.add(m.leadId) }
      }
    }
    for (const [trigger, column] of [['opened', 'opened_at'], ['clicked', 'clicked_at']] as const) {
      const sub = match(c, trigger)
      if (!sub) continue
      const { data } = await db().from('email_messages').select('lead_id').eq('campaign_id', c.id).not(column, 'is', null)
      for (const { lead_id: id } of data ?? []) {
        const t = id ? tracks.get(id) : undefined
        if (id && t && !t.repliedAt && !t.badReason && !seen.has(id)) { await start(c, id, sub); seen.add(id) }
      }
    }
  }
}

/** Send every subsequence email that's due. Call only inside the send window. */
export async function runSubsequences(settings: Settings, campaigns: Campaign[]): Promise<string[]> {
  if (!campaigns.some(c => c.config.subsequences?.length) || !(await inboxSchema())) return []
  const rows = await db().from('lead_tracking').select(TRACKING_COLUMNS).not('sent_at', 'is', null)
  const tracks = new Map(((rows.data ?? []) as unknown as TrackingRow[]).map(r => [r.lead_id, fromRow(r)]))
  await enrollBehavior(campaigns, tracks)

  const { data: runs, error } = await db().from('subsequence_runs').select('lead_id,campaign_id,subsequence_id,enrolled_at').eq('status', 'active')
  if (error) return [error.message]
  const out: string[] = []
  const day = today()
  for (const run of runs ?? []) {
    const r = await advance(settings, campaigns.find(x => x.id === run.campaign_id), run, tracks.get(run.lead_id as string), day)
    if (r) out.push(r)
  }
  return out
}

type Run = { lead_id: string; campaign_id: string; subsequence_id: string; enrolled_at: string }

/** Send this run's next email if it's due. Returns a line for the log, or nothing when there was nothing to send. */
async function advance(settings: Settings, c: Campaign | undefined, run: Run, t: Track | undefined, day: string): Promise<string | undefined> {
  const leadId = run.lead_id
  const end = (status: 'done' | 'stopped') => db().from('subsequence_runs').update({ status }).eq('lead_id', leadId)
  const sub = c?.config.subsequences?.find(s => s.id === run.subsequence_id)
  if (!c || !sub || !sub.enabled || !t || t.badReason) { await end('stopped'); return }

  const { data: msgs } = await db().from('email_messages').select('step,status,sent_at').eq('lead_id', leadId).gte('step', SUB_STEP).order('step')
  const n = msgs?.length ?? 0
  if (n >= sub.steps.length) { await end('done'); return }
  if (msgs?.some(m => m.status !== 'sent')) return
  const prev = msgs?.[n - 1]?.sent_at ?? run.enrolled_at
  if (addDays(etDay(prev), sub.steps[n].gap) > day) return

  const thread = await threadOf(leadId, run.enrolled_at)
  if (thread.answered) { await end('stopped'); return }
  const inbox = [thread.inbox, t.inbox].find((i): i is string => !!i && settings.inboxes.includes(i))
  if (!inbox) return `${leadId}: no live inbox wrote to them`

  try {
    const camp = await loadCampaignLead(leadId, settings)
    const body = camp ? fillVars(sub.steps[n].body, leadVars(camp.member)) : sub.steps[n].body
    const signed = `${body.trimEnd().split('{{sendingAccountFirstName}}').join(inboxPersona(inbox))}\n\n${companyLine(settings)}`
    return `${leadId}: ${await sendThreaded({ leadId, inbox, to: thread.to, subject: thread.subject, body: signed, step: SUB_STEP + n, ids: thread.ids, settings, label: `Subsequence email ${n + 1}` })}`
  } catch (e) {
    return `${leadId}: ${errorMessage(e)}`
  }
}

/**
 * Right after a reply starts a run: send its first email now if it has no wait (gap 0), at any hour and whether or not
 * autopilot is on, so a "yes" gets the video within seconds. The (lead, step) claim keeps it to one send even if the
 * send pass gets there at the same moment. Later emails in the run wait for the send pass as usual.
 */
export async function sendFirstNow(settings: Settings, c: Campaign, leadId: string): Promise<string | undefined> {
  const { data: run } = await db().from('subsequence_runs').select('lead_id,campaign_id,subsequence_id,enrolled_at,status').eq('lead_id', leadId).maybeSingle()
  if (!run || run.status !== 'active' || run.campaign_id !== c.id) return
  const sub = c.config.subsequences?.find(s => s.id === run.subsequence_id)
  if (!sub?.steps[0] || sub.steps[0].gap !== 0) return
  const { data: row } = await db().from('lead_tracking').select(TRACKING_COLUMNS).eq('lead_id', leadId).maybeSingle()
  const t = row ? fromRow(row as unknown as TrackingRow) : undefined
  return advance(settings, c, run as Run, t, today())
}
