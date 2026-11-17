import { createClient } from '@supabase/supabase-js'
import type { Lead, MediaItem, TrackMap } from './types'
import { LEAD_COLUMNS, TRACKING_COLUMNS, fetchAll, fromRow, type TrackingRow } from './core'

export { fromRow, toRow, type TrackingRow } from './core'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const configured = Boolean(url && key)

// Captured before the client consumes the URL: a password-reset or invite link should land on "set password".
export const arrivedToSetPassword = /type=(recovery|invite)/.test(window.location.hash + window.location.search)
export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing')




export async function fetchLeads(): Promise<Lead[]> {
  const rows = await fetchAll<Lead>((from, to) =>
    supabase.from('leads').select(LEAD_COLUMNS).order('sort_order').range(from, to) as unknown as PromiseLike<{ data: Lead[] | null; error: { message: string } | null }>)
  // Nulls from Postgres become empty strings so the UI can treat text fields uniformly.
  return rows.map(l => {
    const out = { ...l } as Record<string, unknown>
    for (const [k, v] of Object.entries(out)) if (v === null && k !== 'rating' && k !== 'reviews') out[k] = ''
    if (typeof out.rating === 'string') out.rating = Number(out.rating)
    return out as unknown as Lead
  })
}


export async function fetchTracking(): Promise<TrackMap> {
  const rows = await fetchAll<TrackingRow>((from, to) =>
    supabase.from('lead_tracking').select(TRACKING_COLUMNS).order('lead_id').range(from, to))
  return Object.fromEntries(rows.map(r => [r.lead_id, fromRow(r)]))
}

// ---------- media (private storage bucket, viewed through short-lived signed links) ----------

const MEDIA_BUCKET = 'lead-media'
const safeKey = (s: string) => s.replace(/[^\w.-]+/g, '_')

export async function uploadMedia(leadId: string, file: File): Promise<MediaItem> {
  const path = `${safeKey(leadId)}/${Date.now()}-${safeKey(file.name)}`
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, { contentType: file.type || undefined })
  if (error) throw new Error(error.message)
  return { name: file.name, path, type: file.type, size: file.size }
}

export async function removeMedia(path: string) {
  const { error } = await supabase.storage.from(MEDIA_BUCKET).remove([path])
  if (error) throw new Error(error.message)
}

/** Signed URLs keyed by storage path, valid for an hour. */
export async function signMedia(paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {}
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600)
  if (error) throw new Error(error.message)
  return Object.fromEntries((data ?? []).flatMap(d => (d.path && d.signedUrl ? [[d.path, d.signedUrl]] : [])))
}

/** Upsert changed records and delete cleared ones, in chunks. */
export async function saveTracking(upserts: TrackingRow[], deletes: string[]) {
  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await supabase.from('lead_tracking').upsert(upserts.slice(i, i + 500), { onConflict: 'lead_id' })
    if (error) throw new Error(error.message)
  }
  for (let i = 0; i < deletes.length; i += 200) {
    const { error } = await supabase.from('lead_tracking').delete().in('lead_id', deletes.slice(i, i + 200))
    if (error) throw new Error(error.message)
  }
}
