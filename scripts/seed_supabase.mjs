// Load data/leads.json into the Supabase `leads` table.
// Usage: node --env-file=.env.local scripts/seed_supabase.mjs
// Re-running is safe: rows are upserted by id, and tracking data is untouched.
import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(url, key, { auth: { persistSession: false } })
const leads = JSON.parse(await readFile(new URL('../data/leads.json', import.meta.url), 'utf8'))

const rows = leads.map((l, i) => ({
  id: l.id,
  sort_order: i,
  wave: l.wave,
  niche_group: l.nicheGroup,
  score: l.score,
  hook: l.hook,
  pitch_angle: l.pitchAngle,
  email_type: l.emailType,
  business_name: l.businessName,
  industry: l.industry,
  niche: l.niche,
  specific_category: l.specificCategory,
  what_they_do: l.whatTheyDo,
  city: l.city,
  address: l.address,
  rating: l.rating,
  reviews: l.reviews,
  website_status: l.websiteStatus,
  website: l.website,
  why_outdated: l.whyOutdated,
  email: l.email,
  email_found_at: l.emailFoundAt,
  google_maps: l.googleMaps,
}))

const CHUNK = 500
for (let i = 0; i < rows.length; i += CHUNK) {
  const { error } = await supabase.from('leads').upsert(rows.slice(i, i + CHUNK), { onConflict: 'id' })
  if (error) {
    console.error(`Failed at rows ${i}-${i + CHUNK}:`, error.message)
    process.exit(1)
  }
  process.stdout.write(`\r${Math.min(i + CHUNK, rows.length)} / ${rows.length}`)
}
console.log('\nDone.')
