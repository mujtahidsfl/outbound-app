import { useState } from 'react'
import { api } from '../../../api'
import { TIME_ZONE, campaignWindow, formatDate, isWritten } from '../../../tracking'
import type { CampaignConfig, RecipientEsp } from '../../../types'
import { SendingToggle, Switch } from '../ColdSettings'
import type { CampaignProps } from './CampaignView'

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Asia/Dubai', 'Asia/Dhaka', 'Asia/Singapore', 'Australia/Sydney']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = Array.from({ length: 25 }, (_, h) => h)
const hourName = (h: number) => (h === 24 ? 'Midnight' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`)
const PROVIDERS: { id: RecipientEsp; label: string }[] = [{ id: 'google', label: 'Gmail & Workspace' }, { id: 'outlook', label: 'Outlook' }, { id: 'other', label: 'Others' }]

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="card settings-list"><h2 className="setting-group">{title}</h2>{children}</section>
}

function Row({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div><div className="strong">{title}</div><p className="small muted">{text}</p></div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

/** A number saved when you leave the box; emptied means "no limit". */
function Num({ value, min = 0, max, placeholder, onSave, label }: { value?: number; min?: number; max?: number; placeholder?: string; onSave: (v: number | undefined) => void; label: string }) {
  const [text, setText] = useState(value == null ? '' : String(value))
  return (
    <input className="input input-sm input-num" type="number" min={min} max={max} placeholder={placeholder} value={text} aria-label={label}
      onChange={e => setText(e.target.value)} onBlur={() => { const v = text === '' ? undefined : Math.max(min, Number(text)); if (v !== value) onSave(v) }} />
  )
}

/** Everything about how a campaign sends. Each change saves as you make it. */
export default function CampaignOptions({ campaign: c, campaigns, settings, setSettings, actions: a, activity, onScreenshots, onDeleted }: CampaignProps & { onScreenshots: () => void; onDeleted: () => void }) {
  const cfg = c.config
  const set = (patch: Partial<CampaignConfig>) => a.saveConfig(patch)
  const win = campaignWindow(c, settings)
  const days = cfg.days?.length ? cfg.days : settings.sendWeekdaysOnly ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]
  const start = cfg.startHour ?? settings.sendStartHour
  const end = cfg.endHour ?? settings.sendEndHour
  const guard = cfg.bounceProtection ?? { enabled: false, threshold: 5 }
  const share = cfg.followUpShare ?? 100
  const [del, setDel] = useState<string>()

  const remove = async () => {
    if (!confirm(`Delete "${c.name}" and its lead list? This can't be undone.`)) return
    const r = await api({ action: 'delete', campaignId: c.id }, '/api/campaign')
    if (r.error) return setDel(r.error)
    campaigns.reload()
    onDeleted()
  }

  return (
    <div className="stack">
      <Group title="Status">
        <Row title="Campaign" text={c.status === 'active' ? 'Active: autopilot sends its emails on the schedule below.' : cfg.pausedReason ? `Paused by reputation protection. ${cfg.pausedReason}` : 'Paused: nothing from this campaign sends.'}>
          {c.status === 'active'
            ? <button className="btn btn-sm" onClick={() => a.activate(false)}>Pause campaign</button>
            : <button className="btn btn-sm btn-primary" onClick={() => a.activate(true)}>Activate</button>}
        </Row>
        <Row title="Follow-ups" text={c.followUpsPaused
          ? `Paused: only Email 1 sends.${a.waiting ? ` ${a.waiting} follow-up${a.waiting === 1 ? ' is' : 's are'} waiting.` : ''}`
          : `Emails 2–${c.steps.length} go out when due, ${c.cadence.join(' / ')} days apart.`}>
          {c.followUpsPaused
            ? <button className="btn btn-sm btn-primary" onClick={a.resume}>Resume follow-ups</button>
            : <button className="btn btn-sm" onClick={() => a.save({ followUpsPaused: true })}>Pause follow-ups</button>}
        </Row>
        {a.needImages.length > 0 && (
          <Row title={`Screenshots for Email ${a.needImages.join(' & ')}`} text={c.images.length ? `${c.images.length} attached.` : "None yet. Follow-ups can't resume until they're uploaded."}>
            <button className="btn btn-sm" onClick={onScreenshots}>{c.images.length ? 'Manage' : 'Upload'}</button>
          </Row>
        )}
        <Row title="Sending (every campaign)" text="The master switch for all campaigns.">
          <SendingToggle settings={settings} setSettings={setSettings} />
        </Row>
      </Group>

      <Group title="Schedule">
        <Row title="Time zone" text="The zone the hours and days below are in. Pick the leads' zone, not yours.">
          <select className="select select-sm" value={cfg.timeZone ?? TIME_ZONE} onChange={e => set({ timeZone: e.target.value })} aria-label="Time zone">
            {ZONES.map(z => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </select>
        </Row>
        <Row title="Active days" text="Days this campaign sends.">
          <span className="day-picks">
            {DAYS.map((d, i) => (
              <button key={d} className={days.includes(i) ? 'day on' : 'day'} aria-pressed={days.includes(i)} onClick={() => {
                const next = days.includes(i) ? days.filter(x => x !== i) : [...days, i].sort()
                if (next.length) set({ days: next })
              }}>{d}</button>
            ))}
          </span>
        </Row>
        <Row title="Sending window" text={`${win.open ? 'Open right now.' : `Closed right now (${win.reason}).`} Each account spreads its emails across this window.`}>
          <span className="row-wrap">
            <select className="select select-sm" value={start} onChange={e => set({ startHour: Number(e.target.value) })} aria-label="Start hour">{HOURS.slice(0, 24).map(h => <option key={h} value={h}>{hourName(h)}</option>)}</select>
            <span className="small muted">to</span>
            <select className="select select-sm" value={end} onChange={e => set({ endHour: Number(e.target.value) })} aria-label="End hour">{HOURS.slice(1).map(h => <option key={h} value={h}>{hourName(h)}</option>)}</select>
          </span>
        </Row>
        <Row title="New leads per day" text="The most first emails a day across all accounts. Empty uses each account's daily cap.">
          <Num value={cfg.newLeadsPerDay} placeholder="No limit" label="New leads per day" onSave={v => set({ newLeadsPerDay: v })} />
        </Row>
        <Row title="Start date" text={!c.startDate ? 'Sends as soon as it is active.' : a.started ? `Started ${formatDate(c.startDate)}.` : `Nothing sends before ${formatDate(c.startDate)}.`}>
          <input type="date" className="input input-sm" value={c.startDate ?? ''} onChange={e => a.save({ startDate: e.target.value || null })} aria-label="Start date" />
        </Row>
      </Group>

      <Group title="Campaign behavior">
        <Row title="Stop on reply" text="Always on. Emailing someone who already answered is how domains get reported.">
          <Switch on onChange={() => {}} label="Stop on reply" />
        </Row>
        <Row title="Stop on click" text="End the sequence for a lead who clicks a link. Needs click tracking.">
          <Switch on={!!cfg.stopOnClick} onChange={v => set({ stopOnClick: v })} label="Stop on click" />
        </Row>
        <Row title="Stop on open" text="End the sequence for a lead who opens. Mail scanners and Apple Mail fake opens, so this also stops people who never read it.">
          <Switch on={!!cfg.stopOnOpen} onChange={v => set({ stopOnOpen: v })} label="Stop on open" />
        </Row>
        {isWritten(c) && (
          <Row title="Email variant distribution" text="How leads split across an email's variants.">
            <select className="select select-sm" value={cfg.variantDistribution ?? 'pattern'} onChange={e => set({ variantDistribution: e.target.value as CampaignConfig['variantDistribution'] })} aria-label="Variant distribution">
              <option value="pattern">Pattern: A, B, C in order</option>
              <option value="even">Even: least-sent variant next</option>
              <option value="random">Random</option>
            </select>
          </Row>
        )}
        <Row title="Company-level auto-pause" text="When someone at a company replies, stop the rest of this campaign's leads at that domain. Skips Gmail-style addresses.">
          <Switch on={!!cfg.companyAutoPause} onChange={v => set({ companyAutoPause: v })} label="Company-level auto-pause" />
        </Row>
        <Row title="Follow-up priority" text={share >= 100 ? 'Follow-ups always go first, then new leads.' : share <= 0 ? 'New leads go first; follow-ups wait until none are left.' : `Up to ${share}% of each day's sends go to follow-ups, the rest to new leads.`}>
          <span className="row-wrap small">
            <span className="muted">New leads</span>
            <input type="range" min={0} max={100} step={10} defaultValue={share} onPointerUp={e => set({ followUpShare: Number(e.currentTarget.value) })} onKeyUp={e => set({ followUpShare: Number(e.currentTarget.value) })} aria-label="Share of sends for follow-ups" />
            <span className="muted">Follow-ups</span>
          </span>
        </Row>
      </Group>

      <Group title="Delivery optimization">
        <Row title="ESP matching" text="New leads go out from a sender on the same provider as them. All your accounts are Google, so this only changes anything once you add another provider.">
          <Switch on={!!cfg.espMatching} onChange={v => set({ espMatching: v })} label="ESP matching" />
        </Row>
        <Row title="Plain text mode" text="Looks like plain text: no signature images or tracked links.">
          <Switch on={!!cfg.plainText} onChange={v => set({ plainText: v })} label="Plain text mode" />
        </Row>
      </Group>

      <Group title="Tracking">
        <Row title="Track email opens" text="Always on: every email carries a small hidden image.">
          <span className="small muted">On</span>
        </Row>
        <Row title="Track link clicks" text={cfg.plainText ? 'Off in plain text mode.' : 'Links go through your app first, which spam filters can dislike. Leave off unless you need it.'}>
          <Switch on={!cfg.plainText && !!cfg.trackClicks} onChange={v => { if (!cfg.plainText) set({ trackClicks: v }) }} label="Track link clicks" />
        </Row>
      </Group>

      <Group title="Email provider">
        <Row title="Send to" text={settings.googleOnly !== false ? 'The app-wide "Gmail inboxes only" setting is on, so only Google addresses go out whatever you pick here.' : 'Leads on other providers are skipped when their first email comes up. Nothing ticked sends to everyone.'}>
          <span className="row-wrap">
            {PROVIDERS.map(p => {
              const list = cfg.providers ?? []
              return (
                <label className="toggle" key={p.id}>
                  <input type="checkbox" checked={list.includes(p.id)} onChange={e => set({ providers: e.target.checked ? [...list, p.id] : list.filter(x => x !== p.id) })} />
                  <span className="small">{p.label}</span>
                </label>
              )
            })}
          </span>
        </Row>
      </Group>

      <Group title="Reputation protection">
        <Row title="High bounce auto-protection" text="Pauses this campaign and emails you once bounces reach the limit, after at least 30 sends.">
          <span className="row-wrap small">
            <Num value={guard.threshold} min={1} max={100} label="Bounce limit percent" onSave={v => set({ bounceProtection: { ...guard, threshold: v ?? 5 } })} />%
            <Switch on={guard.enabled} onChange={v => set({ bounceProtection: { ...guard, enabled: v, since: new Date().toISOString() } })} label="High bounce auto-protection" />
          </span>
        </Row>
        <Row title="Domain-level rate limit" text="The most emails to one company domain per day. Skips Gmail-style addresses.">
          <Num value={cfg.domainDailyLimit} min={1} placeholder="No limit" label="Emails per domain per day" onSave={v => set({ domainDailyLimit: v })} />
        </Row>
      </Group>

      <Group title="Unsubscribe">
        <Row title="Unsubscribe link" text="Always on: every email ends with a hyperlinked unsubscribe line. Anyone who clicks it is never emailed again.">
          <span className="badge badge-replied">On</span>
        </Row>
        <Row title="Message" text="The words that carry the link.">
          <input className="input input-sm alert-input" defaultValue={cfg.unsubscribeText ?? 'Unsubscribe'} onBlur={e => set({ unsubscribeText: e.target.value })} aria-label="Unsubscribe message" />
        </Row>
      </Group>

      {!activity.messages.length && (
        <Group title="Delete">
          <Row title="Delete this campaign" text={del ?? 'Only possible before anything has been sent.'}>
            <button className="btn btn-sm" onClick={remove}>Delete</button>
          </Row>
        </Group>
      )}
    </div>
  )
}
