// Inbox placement test: every sending morning, each inbox sends the real Email 1 to the seed Gmail accounts
// (settings.seedInboxes); a few minutes later the app logs in to each seed over IMAP and records which folder it
// landed in (Primary, Promotions/Updates, Spam, or nowhere). Anything but Primary raises an alert; nothing is paused.
// Runs inside the 5-minute reply job (needs supabase/seed.sql). Seeds log in with a Gmail app password:
// SEED_PASSWORD is shared by every seed; SEED_PASSWORD_<ADDRESS> overrides it for one seed.
import { randomUUID } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { composeCampaignEmail, composeEmail, inboxPersona, sendWindow, today } from '../../src/core.js'
import type { Settings } from '../../src/types.ts'
import type { AlertDraft } from './alerts.js'
import { db, firstLeadOrSample, loadCampaignLead, loadCampaigns, loadSettings } from './db.js'
import { errorMessage, publicUrl, TRACK_OPENS } from './env.js'
import { loginInboxes } from './google.js'
import { buildRaw, emailHtml, smtpSend, unsubscribeLine, unsubscribeText } from './mail.js'

export const SEED = {
  /** The daily test goes out this many minutes before the send window opens, so a spam result shows up first. */
  leadMinutes: 60,
  /** Gmail usually files a message within seconds; wait this long before the first look. */
  firstCheckMs: 3 * 60_000,
  /** Not in any folder after this long: recorded as missing. */
  giveUpMs: 2 * 60 * 60_000,
}

export type Placement = 'pending' | 'inbox' | 'promotions' | 'updates' | 'social' | 'forums' | 'spam' | 'missing' | 'failed'

export interface SeedRow {
  id: number
  run: string
  inbox: string
  seed: string
  message_id: string | null
  subject: string | null
  placement: Placement
  error: string | null
  created_at: string
  sent_at: string | null
  checked_at: string | null
}

const seedVar = (seed: string) => `SEED_PASSWORD_${seed.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
export const seedPassword = (seed: string) => process.env[seedVar(seed)] || process.env.SEED_PASSWORD || ''
const seeds = (settings: Settings) => (settings.seedInboxes ?? []).map(s => s.trim().toLowerCase()).filter(Boolean)

/** One pass from the cron: send today's test once it's time, then check whatever is still pending. */
export async function seedRun(now = new Date()) {
  const settings = await loadSettings()
  if (!seeds(settings).length) return { skipped: 'No seed inboxes set' }
  const probe = await db().from('seed_tests').select('id').limit(1)
  if (probe.error) return { skipped: 'seed.sql not run yet' }

  let sent: Awaited<ReturnType<typeof sendSeedTests>> | undefined
  const day = today()
  // The window check with the start moved earlier: open = it's a sending day and past the test time.
  const early = { ...settings, sendStartHour: settings.sendStartHour - SEED.leadMinutes / 60, sendEndHour: 24 }
  if (sendWindow(early, now).open) {
    const done = await db().from('seed_tests').select('id').eq('run', day).limit(1)
    if (!done.data?.length) sent = await sendSeedTests(settings, day)
  }
  return { sent, checked: await checkSeedTests(now) }
}

/** Send the test from every inbox to every seed. `run` groups them: the ET date for the daily test, or manual-<time>. */
export async function sendSeedTests(settings: Settings, run: string) {
  const list = seeds(settings)
  if (!list.length) throw new Error('Add a seed Gmail address first (Mailboxes → Domain health → Inbox placement test).')
  const content = await sampleEmail(settings)
  const ready = await loginInboxes(settings.inboxes)
  const pairs = settings.inboxes.filter(i => ready.has(i)).flatMap(inbox => list.map(seed => ({ inbox, seed })))
  // The unique (run, inbox, seed) row is claimed first, so two overlapping passes never send twice.
  const claimed = await db().from('seed_tests')
    .upsert(pairs.map(p => ({ run, ...p })), { onConflict: 'run,inbox,seed', ignoreDuplicates: true })
    .select('id,inbox,seed')
  if (claimed.error) throw new Error(claimed.error.message)

  return Promise.all((claimed.data ?? []).map(async ({ id, inbox, seed }) => {
    const { subject, body } = content(inbox)
    const messageId = `<${randomUUID()}@${inbox.split('@')[1]}>`
    try {
      // Built like a real lead email: same text, unsubscribe headers and link, and the HTML part with a pixel when tracking is on.
      const unsubscribe = unsubscribeLine(seed)
      const email = { from: inbox, fromName: inboxPersona(inbox), to: seed, subject, text: `${body}\n\n${unsubscribeText(unsubscribe)}`, messageId, unsubscribeUrl: unsubscribe.url }
      const html = emailHtml(body, { inbox, pixelUrl: TRACK_OPENS ? `${publicUrl()}/api/open?m=0&t=seed` : undefined, unsubscribe })
      await smtpSend(inbox, seed, await buildRaw({ ...email, html }))
      await db().from('seed_tests').update({ message_id: messageId, subject, sent_at: new Date().toISOString() }).eq('id', id)
      return { inbox, seed, ok: true }
    } catch (e) {
      await db().from('seed_tests').update({ placement: 'failed', error: errorMessage(e).slice(0, 300), checked_at: new Date().toISOString() }).eq('id', id)
      return { inbox, seed, ok: false, error: errorMessage(e) }
    }
  }))
}

/** The email the test sends: a real lead's Email 1 from the first active campaign, else the plain template. */
async function sampleEmail(settings: Settings): Promise<(inbox: string) => { subject: string; body: string }> {
  const active = (await loadCampaigns()).find(c => c.status === 'active')
  if (active) {
    const { data } = await db().from('campaign_leads').select('lead_id').eq('campaign_id', active.id).eq('send_status', 'READY').order('position').limit(50)
    const pick = data?.length ? data[Math.floor(Math.random() * data.length)].lead_id : null
    const camp = pick ? await loadCampaignLead(pick) : null
    if (camp?.emails[0]) return inbox => composeCampaignEmail(camp.campaign, camp.member, camp.emails, 0, inbox)
  }
  const lead = await firstLeadOrSample()
  return inbox => composeEmail(lead, settings, false, inbox)
}

/** Look up every pending test in its seed's Gmail and record where it landed. */
export async function checkSeedTests(now = new Date()) {
  const { data, error } = await db().from('seed_tests').select('*').eq('placement', 'pending').not('sent_at', 'is', null)
  if (error) throw new Error(error.message)
  const due = (data as SeedRow[]).filter(r => now.getTime() - Date.parse(r.sent_at!) >= SEED.firstCheckMs)
  const bySeed = new Map<string, SeedRow[]>()
  for (const r of due) bySeed.set(r.seed, [...(bySeed.get(r.seed) ?? []), r])

  const out: Record<string, string> = {}
  await Promise.all([...bySeed].map(async ([seed, rows]) => {
    try {
      const found = await locate(seed, rows.map(r => r.message_id!))
      for (const r of rows) {
        const where = found.get(r.message_id!)
        const placement: Placement | null = where ?? (now.getTime() - Date.parse(r.sent_at!) >= SEED.giveUpMs ? 'missing' : null)
        if (!placement) continue
        await db().from('seed_tests').update({ placement, checked_at: now.toISOString(), error: null }).eq('id', r.id)
        out[`${r.inbox} → ${seed}`] = placement
      }
    } catch (e) {
      // Can't log in to the seed: keep them pending; after the give-up time they fail with the reason.
      const msg = errorMessage(e)
      for (const r of rows) {
        if (now.getTime() - Date.parse(r.sent_at!) < SEED.giveUpMs) continue
        await db().from('seed_tests').update({ placement: 'failed', error: `Couldn't read ${seed}: ${msg}`.slice(0, 300), checked_at: now.toISOString() }).eq('id', r.id)
      }
      out[seed] = `error: ${msg}`
    }
  }))
  return out
}

/** Find each Message-ID in the seed's Gmail: Inbox (and which tab), Spam, or not there yet. */
async function locate(seed: string, ids: string[]): Promise<Map<string, Placement>> {
  const pass = seedPassword(seed)
  if (!pass) throw new Error(`No app password: add SEED_PASSWORD (or ${seedVar(seed)}) in Vercel`)
  if (!/@(gmail|googlemail)\.com$/i.test(seed)) throw new Error('Only Gmail seed accounts are supported')
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: seed, pass }, logger: false, connectionTimeout: 15_000 })
  const found = new Map<string, Placement>()
  const bare = (id: string) => id.replace(/^<|>$/g, '')
  const has = async (raw: string) => ((await client.search({ gmraw: raw }, { uid: true })) || []).length > 0
  await client.connect()
  try {
    let lock = await client.getMailboxLock('INBOX')
    try {
      for (const id of ids) {
        if (!(await has(`rfc822msgid:${bare(id)}`))) continue
        let tab: Placement = 'inbox'
        for (const c of ['promotions', 'updates', 'social', 'forums'] as const) if (await has(`rfc822msgid:${bare(id)} category:${c}`)) { tab = c; break }
        found.set(id, tab)
      }
    } finally {
      lock.release()
    }
    const junk = (await client.list()).find(f => f.specialUse === '\\Junk')?.path ?? '[Gmail]/Spam'
    lock = await client.getMailboxLock(junk)
    try {
      for (const id of ids) if (!found.has(id) && (await has(`rfc822msgid:${bare(id)}`))) found.set(id, 'spam')
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
  return found
}

/** Each inbox's latest finished result (any seed in Spam counts as Spam). */
export async function latestPlacements(): Promise<Map<string, { placement: Placement; seed: string; at: string }> | null> {
  const { data, error } = await db().from('seed_tests').select('inbox,seed,placement,checked_at').neq('placement', 'pending')
    .not('checked_at', 'is', null).order('checked_at', { ascending: false }).limit(500)
  if (error) return null
  const out = new Map<string, { placement: Placement; seed: string; at: string }>()
  for (const r of data as Pick<SeedRow, 'inbox' | 'seed' | 'placement' | 'checked_at'>[]) {
    const cur = out.get(r.inbox)
    // Same run (within a few hours): Spam beats everything else.
    if (!cur) out.set(r.inbox, { placement: r.placement, seed: r.seed, at: r.checked_at! })
    else if (r.placement === 'spam' && Date.parse(cur.at) - Date.parse(r.checked_at!) < 3 * 3600e3) cur.placement = 'spam'
  }
  return out
}

/** Alerts for the guard pass: anything but a clean Primary-inbox result on an inbox's latest test. */
export async function seedAlerts(settings: Settings): Promise<AlertDraft[] | null> {
  if (!seeds(settings).length) return []
  const latest = await latestPlacements()
  if (!latest) return null
  const alerts: AlertDraft[] = []
  for (const inbox of settings.inboxes) {
    const r = latest.get(inbox)
    if (!r || r.placement === 'inbox') continue
    const tab = ['promotions', 'updates', 'social', 'forums'].includes(r.placement)
    alerts.push({
      key: `seed:${inbox}`,
      level: r.placement === 'spam' ? 'critical' : 'warn',
      inbox,
      title: r.placement === 'spam' ? `${inbox} landed in Gmail spam`
        : tab ? `${inbox} landed in Gmail's ${r.placement[0].toUpperCase()}${r.placement.slice(1)} tab`
        : r.placement === 'missing' ? `${inbox}'s test email never arrived` : `${inbox}'s inbox test couldn't run`,
      detail: r.placement === 'spam'
        ? `This morning's test to ${r.seed} went to Spam. It is still sending: lower its cap or take it out of rotation.`
        : tab ? `The test to ${r.seed} skipped Primary. Leads read Primary first, so expect fewer opens and replies from this inbox. Plainer wording and no links help.`
        : r.placement === 'missing' ? `The test to ${r.seed} wasn't in the Inbox or Spam two hours later. Gmail may be rejecting this inbox's mail outright.`
        : `See Mailboxes → Domain health → Inbox placement test for the error.`,
    })
  }
  return alerts
}
