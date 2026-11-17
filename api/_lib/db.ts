// Supabase access for the server, using the service role key (bypasses row-level security; server-only).
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  CAMPAIGN_LEAD_COLUMNS, DEFAULT_SETTINGS, EMPTY_TRACK, GUARD_COLUMNS, LEAD_COLUMNS, TRACKING_COLUMNS, fetchAll, fromRow, guardFromRows, isWritten,
  normalizeCampaignLead, templateEmails, toRow, withCampaignConfig, type GuardRow, type TrackingRow,
} from '../../src/core.js'
import type { Campaign, CampaignEmail, CampaignLead, Lead, Settings, Track, TrackMap } from '../../src/types.ts'
import { requireEnv } from './env.js'

let client: SupabaseClient | undefined

export function db(): SupabaseClient {
  client ??= createClient(
    process.env.SUPABASE_URL || requireEnv('VITE_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  return client
}

let schemaReady = false

/**
 * Whether master_inbox.sql has run. Everything that writes its new columns and tables checks this first, because the
 * code can reach production before the SQL does and sending must not stop if it does.
 */
export async function inboxSchema() {
  if (schemaReady) return true
  const { error } = await db().from('inbox_threads').select('lead_id').limit(1)
  schemaReady = !error
  return schemaReady
}

/** The signed-in dashboard user behind a request, or null. */
export async function userFromRequest(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data, error } = await db().auth.getUser(token)
  return error ? null : data.user
}

export async function loadSettings(): Promise<Settings> {
  const { data, error } = await db().from('app_settings').select('data').eq('id', 1).maybeSingle()
  if (error) throw new Error(error.message)
  const settings: Settings = { ...DEFAULT_SETTINGS, ...((data?.data ?? {}) as Partial<Settings>) }
  // The guard lives in its own table; before guard.sql runs there is none and caps work as before.
  const g = await db().from('inbox_guard').select(GUARD_COLUMNS)
  if (g.error) delete settings.guard
  else settings.guard = guardFromRows(g.data as unknown as GuardRow[])
  return settings
}

/** Create or update one inbox's guard row ('*' = every inbox). */
export async function saveGuard(inbox: string, row: Partial<Omit<GuardRow, 'inbox'>>) {
  const { error } = await db().from('inbox_guard').upsert({ inbox, ...row }, { onConflict: 'inbox' })
  if (error) throw new Error(error.message)
}

/** Merge a few keys into the shared settings row without clobbering the rest. */
export async function patchSettings(patch: Partial<Settings>) {
  const { data, error } = await db().from('app_settings').select('data').eq('id', 1).maybeSingle()
  if (error) throw new Error(error.message)
  const next = { ...((data?.data ?? {}) as Partial<Settings>), ...patch }
  const res = await db().from('app_settings').update({ data: next }).eq('id', 1)
  if (res.error) throw new Error(res.error.message)
}

export async function loadTracks(): Promise<TrackMap> {
  const rows = await fetchAll<TrackingRow>((from, to) =>
    db().from('lead_tracking').select(TRACKING_COLUMNS).order('lead_id').range(from, to))
  return Object.fromEntries(rows.map(r => [r.lead_id, fromRow(r)]))
}

export async function loadTrack(leadId: string): Promise<Track | undefined> {
  const { data, error } = await db().from('lead_tracking').select(TRACKING_COLUMNS).eq('lead_id', leadId).maybeSingle()
  if (error) throw new Error(error.message)
  return data ? fromRow(data as TrackingRow) : undefined
}

/** Read-modify-write one lead's tracking, starting from the latest saved row so teammates' edits aren't lost. */
export async function updateTrack(leadId: string, fn: (t: Track) => Track) {
  const next = fn((await loadTrack(leadId)) ?? EMPTY_TRACK)
  const { error } = await db().from('lead_tracking').upsert(toRow(leadId, next), { onConflict: 'lead_id' })
  if (error) throw new Error(error.message)
}

export async function loadLeads(ids: string[]): Promise<Lead[]> {
  if (!ids.length) return []
  const { data, error } = await db().from('leads').select(LEAD_COLUMNS).in('id', ids)
  if (error) throw new Error(error.message)
  // Nulls become empty strings, matching what the dashboard does.
  return (data as unknown as Record<string, unknown>[]).map(l => {
    const out = { ...l }
    for (const [k, v] of Object.entries(out)) if (v === null && k !== 'rating' && k !== 'reviews') out[k] = ''
    if (typeof out.rating === 'string') out.rating = Number(out.rating)
    return out as unknown as Lead
  })
}

/** Every lead id in priority order (the spreadsheet's order). */
export async function leadIdsByPriority(): Promise<string[]> {
  const rows = await fetchAll<{ id: string }>((from, to) => db().from('leads').select('id').order('sort_order').range(from, to))
  return rows.map(r => r.id)
}

/** Fills test emails before any leads are loaded, so a test still shows the template. */
const SAMPLE_LEAD: Lead = {
  id: 'sample', wave: 0, nicheGroup: '', score: 0, hook: '', pitchAngle: '', emailType: '',
  businessName: 'Sample Business', industry: 'Home services', niche: 'Plumbing', specificCategory: 'Plumber',
  whatTheyDo: 'plumbing repairs', city: 'Springfield', address: '', rating: 4.8, reviews: 120, websiteStatus: '',
  website: '', whyOutdated: '', email: 'sample@example.com', emailFoundAt: '', googleMaps: '',
}

/** The top-priority lead, or a sample one while the leads table is empty. */
export async function firstLeadOrSample(): Promise<Lead> {
  const [first] = await leadIdsByPriority()
  const [lead] = first ? await loadLeads([first]) : []
  return lead ?? SAMPLE_LEAD
}

// ---------- campaigns ----------

export async function loadCampaigns(): Promise<Campaign[]> {
  return withCampaignConfig<Campaign[]>(cols => db().from('campaigns').select(cols).order('created_at'))
}

export type Member = Pick<CampaignLead, 'campaignId' | 'leadId' | 'position' | 'sendStatus' | 'approved' | 'toEmail'>

/** Every lead in every campaign (light columns), in send order. */
export async function loadMembers(): Promise<Member[]> {
  return fetchAll<Member>((from, to) => db().from('campaign_leads')
    .select('campaignId:campaign_id,leadId:lead_id,position,sendStatus:send_status,approved,toEmail:to_email')
    .order('campaign_id').order('position').range(from, to) as unknown as PromiseLike<{ data: Member[] | null; error: { message: string } | null }>)
}

/** A lead's campaign membership with its written emails, or null when the lead isn't in a campaign. */
export async function loadCampaignLead(leadId: string, settings?: Settings): Promise<{ campaign: Campaign; member: CampaignLead; emails: CampaignEmail[] } | null> {
  const load = (cols: string) => db().from('campaign_leads').select(cols).eq('lead_id', leadId).maybeSingle()
  let res = await load(`${CAMPAIGN_LEAD_COLUMNS},emails,vars`)
  if (res.error && /vars/i.test(res.error.message)) res = await load(`${CAMPAIGN_LEAD_COLUMNS},emails`)
  if (res.error) throw new Error(res.error.message)
  if (!res.data) return null
  const { emails, ...rest } = res.data as unknown as CampaignLead & { emails: CampaignEmail[] }
  const campaign = await withCampaignConfig<Campaign>(cols => db().from('campaigns').select(cols).eq('id', rest.campaignId).single())
  const member = normalizeCampaignLead(rest)
  // Written campaigns keep one sequence for every lead, so an edit reaches every email that hasn't gone out yet.
  const written = isWritten(campaign) ? templateEmails(campaign, member, settings ?? await loadSettings()) : [...emails].sort((a, b) => a.step - b.step)
  return { campaign, member, emails: written }
}

/** The lead a campaign sends to at this address (the campaign's cleaned address can differ from the lead id). */
export async function leadIdByCampaignEmail(email: string): Promise<string | undefined> {
  if (!email) return undefined
  const { data } = await db().from('campaign_leads').select('lead_id').ilike('to_email', email).limit(1)
  return data?.[0]?.lead_id ?? undefined
}

/** Download screenshots from the campaign-media bucket as email attachments. */
export async function loadAttachments(images: Campaign['images']) {
  return Promise.all(images.filter(i => i.path).map(async i => {
    const { data, error } = await db().storage.from('campaign-media').download(i.path!)
    if (error || !data) throw new Error(`Couldn't load screenshot ${i.name}: ${error?.message ?? 'missing'}`)
    return { filename: i.name, content: Buffer.from(await data.arrayBuffer()), contentType: i.type || data.type || undefined }
  }))
}
