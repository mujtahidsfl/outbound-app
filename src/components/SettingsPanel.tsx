import { useEffect, useRef, useState } from 'react'
import type { Derived, Lead, Settings, TrackMap } from '../types'
import { DEFAULT_SETTINGS, STATUS_LABEL, emailFooter, fillTemplate, footerReady, inboxCap, today, warmupWeek } from '../tracking'

export default function SettingsPanel({ leads, tracks, derived, settings, setSettings, replaceAll }: {
  leads: Lead[]
  tracks: TrackMap
  derived: Map<string, Derived>
  settings: Settings
  setSettings: (s: Settings) => void
  replaceAll: (t: TrackMap) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const sample = leads.find(l => l.hook === 'outdated site') ?? leads[0]
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v })

  const setCadence = (i: number, v: number) => set('cadence', settings.cadence.map((d, j) => (j === i ? Math.max(1, v || 1) : d)))

  const backup = () => download(
    `outreach-backup-${today()}.json`,
    JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tracks, settings }, null, 2),
    'application/json',
  )

  const restore = async (file: File) => {
    try {
      const data = JSON.parse(await file.text())
      if (!data.tracks || typeof data.tracks !== 'object') throw new Error('No tracking data in file')
      const known = new Set(leads.map(l => l.id))
      replaceAll(Object.fromEntries(Object.entries(data.tracks as TrackMap).filter(([id]) => known.has(id))))
      if (data.settings) setSettings({ ...DEFAULT_SETTINGS, ...data.settings })
      setMsg(`Restored ${Object.keys(data.tracks).length} lead records.`)
    } catch (e) {
      setMsg(`Could not restore: ${e instanceof Error ? e.message : e}`)
    }
  }

  const exportCsv = () => {
    const cols = ['wave', 'niche_group', 'business_name', 'email', 'email_type', 'city', 'niche', 'hook', 'status',
      'sent_from_inbox', 'first_email_sent', 'follow_ups_sent', 'last_follow_up', 'next_follow_up', 'replied_at', 'bad_data', 'media_done', 'media_attached', 'notes', 'website', 'google_maps']
    const lines = leads.map(l => {
      const t = tracks[l.id]
      const d = derived.get(l.id)!
      return [l.wave, l.nicheGroup, l.businessName, l.email, l.emailType, l.city, l.niche, l.hook, STATUS_LABEL[d.status],
        t?.inbox, t?.sentAt, t?.followUps.length ?? 0, t?.followUps.at(-1), d.nextDue, t?.repliedAt, t?.badReason, t?.mediaDone ? 'yes' : '', t?.media?.length ?? 0, t?.notes, l.website, l.googleMaps]
        .map(csvCell).join(',')
    })
    download(`leads-status-${today()}.csv`, [cols.join(','), ...lines].join('\n'), 'text/csv')
  }

  return (
    <div className="stack">
      <div className="grid-2">
        <section className="card">
          <header className="card-head"><h2>Follow-up cadence</h2></header>
          <p className="muted small">Days to wait after the previous email before each follow-up is due.</p>
          <div className="cadence">
            {settings.cadence.map((d, i) => (
              <label key={i} className="cadence-step">
                <span className="small">Follow-up {i + 1}</span>
                <span className="row-wrap">
                  <input type="number" min={1} className="input input-sm num-input" value={d} onChange={e => setCadence(i, Number(e.target.value))} />
                  <span className="small muted">days after {i === 0 ? 'first email' : `#${i}`}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="row-wrap">
            <button className="btn btn-sm" onClick={() => set('cadence', [...settings.cadence, 7])} disabled={settings.cadence.length >= 6}>+ Add follow-up</button>
            <button className="btn btn-sm btn-ghost" onClick={() => set('cadence', settings.cadence.slice(0, -1))} disabled={settings.cadence.length <= 1}>Remove last</button>
          </div>
        </section>

        <section className="card">
          <header className="card-head"><h2>Sending</h2></header>
          <label className="field">
            <span className="small">Daily email target, all steps (first emails + follow-ups)</span>
            <input type="number" min={1} className="input num-input" value={settings.dailyEmailTarget} onChange={e => set('dailyEmailTarget', Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className="field">
            <span className="small">Daily first-email target</span>
            <input type="number" min={1} className="input num-input" value={settings.dailyTarget} onChange={e => set('dailyTarget', Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className="field">
            <span className="small">Your name (fills <code>{'{sender_name}'}</code>)</span>
            <input className="input" value={settings.senderName} onChange={e => set('senderName', e.target.value)} placeholder="e.g. Alex" />
          </label>
        </section>
      </div>

      <section className="card">
        <header className="card-head">
          <h2>Email templates</h2>
          <button className="btn btn-sm btn-ghost" onClick={() => setSettings({
            ...settings,
            firstSubject: DEFAULT_SETTINGS.firstSubject,
            firstBody: DEFAULT_SETTINGS.firstBody,
            followUpSubject: DEFAULT_SETTINGS.followUpSubject,
            followUpBody: DEFAULT_SETTINGS.followUpBody,
          })}>
            Reset templates
          </button>
        </header>
        <p className="muted small">
          Placeholders: <code>{'{business_name}'}</code> <code>{'{city}'}</code> <code>{'{niche}'}</code> <code>{'{category}'}</code>{' '}
          <code>{'{website}'}</code> <code>{'{observation}'}</code> (a line written from the lead's hook) <code>{'{pitch_angle}'}</code> <code>{'{sender_name}'}</code>
        </p>
        <div className="grid-2">
          <TemplateEditor
            title="First email"
            subject={settings.firstSubject}
            body={settings.firstBody}
            onSubject={v => set('firstSubject', v)}
            onBody={v => set('firstBody', v)}
            preview={`${fillTemplate(settings.firstSubject, sample, settings)}\n\n${fillTemplate(settings.firstBody, sample, settings)}`}
          />
          <TemplateEditor
            title="Follow-up"
            subject={settings.followUpSubject}
            body={settings.followUpBody}
            onSubject={v => set('followUpSubject', v)}
            onBody={v => set('followUpBody', v)}
            preview={`${fillTemplate(settings.followUpSubject, sample, settings)}\n\n${fillTemplate(settings.followUpBody, sample, settings)}`}
          />
        </div>
      </section>

      <section className="card">
        <header className="card-head"><h2>Data</h2></header>
        <p className="muted small">
          Tracking (sent, replies, follow-ups, bad-data flags, media, notes) is saved to Supabase and shared with everyone who signs in. Backups are a snapshot you can restore if something gets wiped. Restoring replaces everyone's current tracking.
        </p>
        <div className="row-wrap">
          <button className="btn btn-primary" onClick={backup}>Download backup (.json)</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Restore backup…</button>
          <button className="btn" onClick={exportCsv}>Export leads + status (.csv)</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) restore(f); e.target.value = '' }} />
          <span className="spacer" />
          <button
            className="btn btn-danger"
            onClick={() => {
              if (confirm('Clear ALL tracking data (sent, replies, flags, notes) for the whole team? Download a backup first if unsure.')) {
                replaceAll({})
                setMsg('Tracking data cleared.')
              }
            }}
          >
            Clear all tracking
          </button>
        </div>
        {msg && <p className="small">{msg}</p>}
      </section>
    </div>
  )
}

const HOURS = Array.from({ length: 25 }, (_, h) => h)
const hourName = (h: number) => (h === 24 ? 'midnight' : new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' }))

export function SendingSettings({ settings, setSettings }: { settings: Settings; setSettings: (s: Settings) => void }) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v })
  const now = today()
  const footer = emailFooter(settings)
  const toggleWarmup = (inbox: string, on: boolean) =>
    set('warmupInboxes', on ? [...settings.warmupInboxes, inbox] : settings.warmupInboxes.filter(i => i !== inbox))
  const setCap = (week: number, v: number) => set('warmupCaps', settings.warmupCaps.map((c, i) => (i === week ? Math.max(1, v || 1) : c)))
  const week = warmupWeek(settings, now)
  return (
    <section className="card">
      <header className="card-head"><h2>Sending from the app</h2></header>
      <div className="grid-2">
        <div>
          <h3>Footer (required)</h3>
          <p className="muted small">The law (CAN-SPAM) requires every cold email to say who it's from and include a real postal address. Nothing sends until both are filled in.</p>
          <label className="field">
            <span className="small">Company name</span>
            <input className="input" value={settings.companyName} onChange={e => set('companyName', e.target.value)} placeholder="e.g. Your Company" />
          </label>
          <label className="field">
            <span className="small">Mailing address</span>
            <textarea className="input textarea" rows={2} value={settings.mailingAddress} onChange={e => set('mailingAddress', e.target.value)} placeholder="Street, City, State ZIP" />
          </label>
          {footerReady(settings)
            ? <pre className="preview footer-preview">{footer}</pre>
            : <p className="small due-text">Add both to turn on sending.</p>}
        </div>
        <div>
          <h3>Send window (Eastern Time)</h3>
          <div className="row-wrap spaced">
            <select className="select" value={settings.sendStartHour} onChange={e => set('sendStartHour', Number(e.target.value))} aria-label="Start sending at">
              {HOURS.slice(0, 24).map(h => <option key={h} value={h}>{hourName(h)}</option>)}
            </select>
            <span className="small muted">to</span>
            <select className="select" value={settings.sendEndHour} onChange={e => set('sendEndHour', Number(e.target.value))} aria-label="Stop sending at">
              {HOURS.filter(h => h > settings.sendStartHour).map(h => <option key={h} value={h}>{hourName(h)}</option>)}
            </select>
          </div>
          <label className="toggle spaced">
            <input type="checkbox" checked={settings.sendWeekdaysOnly} onChange={e => set('sendWeekdaysOnly', e.target.checked)} />
            <span className="small">Weekdays only</span>
          </label>

          <h3>Warm-up</h3>
          <p className="muted small">
            Inboxes ticked here ramp up week by week; the rest send {settings.inboxDailyLimit} a day from the start, or their own limit where one is set.
            {settings.guard
              ? <> Each inbox ramps from its own first send, so new inboxes start at week 1.</>
              : settings.warmupStart
              ? <> Started {settings.warmupStart}: now in week {week + 1}.</>
              : <> Starts automatically on the first email the app sends.</>}
          </p>
          <div className="warmup-caps spaced">
            {settings.warmupCaps.map((c, i) => (
              <label key={i} className="small">
                Week {i + 1}
                <input type="number" min={1} className="input input-sm num-input" value={c} onChange={e => setCap(i, Number(e.target.value))} />
              </label>
            ))}
            <label className="small">
              After warm-up
              <input type="number" min={1} className="input input-sm num-input" value={settings.inboxDailyLimit} onChange={e => set('inboxDailyLimit', Math.max(1, Number(e.target.value) || 1))} />
            </label>
          </div>
          <div className="warmup-list">
            {settings.inboxes.map(i => (
              <label key={i} className="toggle small">
                <input type="checkbox" checked={settings.warmupInboxes.includes(i)} onChange={e => toggleWarmup(i, e.target.checked)} />
                <span className="mono">{i}</span>
                <span className="muted">{inboxCap(settings, i, now)}/day today{settings.guard && settings.warmupInboxes.includes(i) ? ` · ${settings.guard[i]?.warmupStart ? `week ${warmupWeek(settings, now, i) + 1}` : 'starts on first send'}` : ''}</span>
              </label>
            ))}
          </div>
          <label className="field">
            <span className="small">Warm-up start date</span>
            <input type="date" className="input input-sm" value={settings.warmupStart} max={now} onChange={e => set('warmupStart', e.target.value)} />
          </label>
        </div>
      </div>
    </section>
  )
}

export function InboxesEditor({ inboxes, onInboxes }: { inboxes: string[]; onInboxes: (v: string[]) => void }) {
  // Edited as free text and saved on blur, so blank lines while typing aren't stripped out mid-edit.
  // Addresses only: how many each sends comes from the warm-up ramp, or a number typed in for today on Email accounts.
  const saved = inboxes.join('\n')
  const [text, setText] = useState(saved)
  useEffect(() => setText(saved), [saved])
  const save = () => {
    const list: string[] = []
    for (const line of text.split(/[\n,]+/)) {
      const addr = line.trim().toLowerCase().split(/\s+/)[0]
      if (addr && !list.includes(addr)) list.push(addr)
    }
    if (list.join('\n') !== saved) onInboxes(list)
    else setText(saved)
  }
  return (
    <section className="card">
      <header className="card-head"><h2>Inboxes</h2></header>
      <p className="muted small">
        Sending inboxes, one per line. To add one, use Add inbox on the Accounts tab: it signs in with Google and fills this in.
        How many each one sends comes from the warm-up ramp below. To change one account for today, type a number in Limit today on Email accounts.
      </p>
      <label className="field">
        <span className="small">Inbox addresses</span>
        <textarea className="input textarea mono" rows={Math.max(4, inboxes.length + 1)} value={text} onChange={e => setText(e.target.value)} onBlur={save} />
      </label>
    </section>
  )
}

function TemplateEditor({ title, subject, body, onSubject, onBody, preview }: {
  title: string
  subject: string
  body: string
  onSubject: (v: string) => void
  onBody: (v: string) => void
  preview: string
}) {
  const [showPreview, setShowPreview] = useState(false)
  return (
    <div className="template">
      <div className="card-head">
        <h3>{title}</h3>
        <button className="btn btn-sm btn-ghost" onClick={() => setShowPreview(p => !p)}>{showPreview ? 'Edit' : 'Preview'}</button>
      </div>
      {showPreview ? (
        <pre className="preview">{preview}</pre>
      ) : (
        <>
          <input className="input" value={subject} onChange={e => onSubject(e.target.value)} aria-label={`${title} subject`} />
          <textarea className="input textarea" rows={11} value={body} onChange={e => onBody(e.target.value)} aria-label={`${title} body`} />
        </>
      )}
    </div>
  )
}

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
