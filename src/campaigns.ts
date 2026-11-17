// Campaigns in the browser: the campaign rows and their leads (live), plus each campaign's full send/reply history.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CAMPAIGN_LEAD_COLUMNS, LIVE_EVENTS, fetchAll, normalizeCampaignLead, withCampaignConfig } from './core'
import { supabase } from './supabase'
import type { Campaign, CampaignEmail, CampaignLead, MediaItem, ReplyIntent } from './types'

export type CampaignMsg = {
  id: number; lead_id: string | null; step: number; inbox: string; to_email: string; subject: string | null
  subject_variant: string | null; attachments: number; status: string; error: string | null; source: string
  created_at: string; sent_at: string | null
  /** Open tracking (after opens.sql): sent with the pixel, first open, times the pixel loaded. */
  tracked?: boolean; opened_at?: string | null; open_count?: number
}
export type CampaignEvt = {
  id: number; lead_id: string | null; inbox: string; kind: string; from_email: string | null; subject: string | null
  snippet: string | null; message_id: string; received_at: string | null; created_at: string; step: number | null
  intent: ReplyIntent | null
}

export interface CampaignState {
  campaigns: Campaign[]
  /** Campaign membership by lead id. */
  members: Map<string, CampaignLead>
  /** Missing tables (campaigns.sql not run yet) or a load error. */
  error?: string
  loaded: boolean
  update: (id: string, patch: Partial<Campaign>) => Promise<string | undefined>
  setApproved: (leadIds: string[], approved: boolean) => Promise<string | undefined>
  reload: () => Promise<void>
}

const toDb = (p: Partial<Campaign>) => {
  const map: Record<string, string> = { followUpsPaused: 'follow_ups_paused', startDate: 'start_date', subjectB: 'subject_b', autoStatuses: 'auto_statuses' }
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [map[k] ?? k, v]))
}

export function useCampaigns(): CampaignState {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [list, setList] = useState<CampaignLead[]>([])
  const [error, setError] = useState<string>()
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(async () => {
    try {
      const c = await withCampaignConfig<Campaign[]>(cols => supabase.from('campaigns').select(cols).order('created_at'))
      const m = await fetchAll<CampaignLead>((from, to) => supabase.from('campaign_leads').select(CAMPAIGN_LEAD_COLUMNS)
        .order('position').range(from, to) as unknown as PromiseLike<{ data: CampaignLead[] | null; error: { message: string } | null }>)
      setCampaigns(c)
      setList(m.map(normalizeCampaignLead))
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    reload()
    const channel = supabase.channel('campaigns')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, () => reload())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [reload])

  const members = useMemo(() => new Map(list.map(m => [m.leadId, m])), [list])

  const update = useCallback(async (id: string, patch: Partial<Campaign>) => {
    setCampaigns(cs => cs.map(c => (c.id === id ? { ...c, ...patch } : c)))
    const { error } = await supabase.from('campaigns').update(toDb(patch)).eq('id', id)
    if (error) {
      reload()
      return error.message
    }
  }, [reload])

  const setApproved = useCallback(async (leadIds: string[], approved: boolean) => {
    const ids = new Set(leadIds)
    setList(l => l.map(m => (ids.has(m.leadId) ? { ...m, approved } : m)))
    for (let i = 0; i < leadIds.length; i += 200) {
      const { error } = await supabase.from('campaign_leads').update({ approved }).in('lead_id', leadIds.slice(i, i + 200))
      if (error) {
        reload()
        return error.message
      }
    }
  }, [reload])

  return { campaigns, members, error, loaded, update, setApproved, reload }
}

/** Every email and inbox event for one campaign, refreshed every minute while shown. */
export function useCampaignActivity(campaignId: string | undefined) {
  const [messages, setMessages] = useState<CampaignMsg[]>([])
  const [events, setEvents] = useState<CampaignEvt[]>([])
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    if (!campaignId) return
    try {
      const cols = 'id,lead_id,step,inbox,to_email,subject,subject_variant,attachments,status,error,source,created_at,sent_at'
      const msgs = (select: string) => fetchAll<CampaignMsg>((from, to) => supabase.from('email_messages')
        .select(select).eq('campaign_id', campaignId).order('id').range(from, to) as unknown as PromiseLike<{ data: CampaignMsg[] | null; error: { message: string } | null }>)
      const [m, e] = await Promise.all([
        // Before opens.sql runs, the open columns don't exist yet: fall back to the original columns.
        msgs(`${cols},tracked,opened_at,open_count`).catch(err => (/column/i.test(String(err?.message)) ? msgs(cols) : Promise.reject(err))),
        // Link unsubscribes and bounces carry no campaign id when they can't be threaded, so match on the lead later.
        fetchAll<CampaignEvt>((from, to) => supabase.from('email_events')
          .select('id,lead_id,inbox,kind,from_email,subject,snippet,message_id,received_at,created_at,step,intent')
          .or(LIVE_EVENTS).order('id').range(from, to)),
      ])
      setMessages(m)
      setEvents(e)
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [campaignId])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 60_000)
    return () => clearInterval(id)
  }, [refresh])

  const setIntent = useCallback(async (eventId: number, intent: ReplyIntent) => {
    setEvents(es => es.map(e => (e.id === eventId ? { ...e, intent } : e)))
    const { error } = await supabase.from('email_events').update({ intent }).eq('id', eventId)
    if (error) setError(error.message)
  }, [])

  return { messages, events, error, refresh, setIntent }
}

export async function fetchCampaignEmails(leadId: string): Promise<CampaignEmail[]> {
  const { data, error } = await supabase.from('campaign_leads').select('emails').eq('lead_id', leadId).single()
  if (error) throw new Error(error.message)
  return [...((data as { emails: CampaignEmail[] }).emails)].sort((a, b) => a.step - b.step)
}

/** A lead's uploaded columns, for previewing a written campaign. */
export async function fetchLeadVars(leadId: string): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('campaign_leads').select('vars').eq('lead_id', leadId).single()
  if (error) throw new Error(error.message)
  return (data as { vars: Record<string, string> | null }).vars ?? {}
}

// ---------- screenshots (campaign-media bucket) ----------

const BUCKET = 'campaign-media'
const MAX_SIDE = 1600

/**
 * Big screenshots make the email heavy, and heavy cold emails land in spam more often.
 * Anything over ~350 KB is scaled to 1600px on the long side and re-encoded as JPEG, if that's smaller.
 */
async function shrink(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size < 350_000) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.85))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}

export async function uploadCampaignImage(campaignId: string, original: File): Promise<MediaItem> {
  const file = await shrink(original)
  const safe = file.name.replace(/[^\w.-]+/g, '_')
  const path = `${campaignId}/${Date.now()}-${safe}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined })
  if (error) throw new Error(error.message)
  return { name: file.name, path, type: file.type, size: file.size }
}

export async function removeCampaignImage(path: string) {
  const { error } = await supabase.storage.from(BUCKET).remove([path])
  if (error) throw new Error(error.message)
}

export async function signCampaignImages(paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {}
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
  if (error) throw new Error(error.message)
  return Object.fromEntries((data ?? []).flatMap(d => (d.path && d.signedUrl ? [[d.path, d.signedUrl]] : [])))
}
