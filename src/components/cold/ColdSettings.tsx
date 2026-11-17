import type { Settings } from '../../types'
import { footerReady, sendWindow } from '../../tracking'
import { InboxesEditor, SendingSettings } from '../SettingsPanel'
import type { ColdProps } from './ColdApp'

const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' })

/** AromaLisa-style "Sending ON · Turn off" pill that controls autopilot. */
export function SendingToggle({ settings, setSettings }: { settings: Settings; setSettings: (s: Settings) => void }) {
  const ready = footerReady(settings)
  const toggle = (on: boolean) => {
    if (on && !confirm('Turn sending on? Autopilot will start sending real emails from your inboxes during the send window.')) return
    setSettings({ ...settings, autopilot: on })
  }
  return (
    <span className={settings.autopilot ? 'toggle-pill on' : 'toggle-pill'}>
      Sending {settings.autopilot ? 'ON' : 'OFF'}
      <button
        className={settings.autopilot ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
        onClick={() => toggle(!settings.autopilot)}
        disabled={!ready && !settings.autopilot}
        title={!ready && !settings.autopilot ? 'Set the company name and mailing address in Settings first' : undefined}
      >
        {settings.autopilot ? 'Turn off' : 'Turn on'}
      </button>
    </span>
  )
}

/** Mailboxes → Sending settings: inboxes and caps, footer, send window, warm-up, open tracking and alerts. */
export function SendingSettingsTab({ settings, setSettings }: ColdProps) {
  const win = sendWindow(settings)
  const set = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch })
  return (
    <div className="stack">
      <section className="card settings-list">
        <Row title="Sending" text={!footerReady(settings)
          ? 'Set the company name and mailing address below first. Nothing can send until they are set.'
          : `${hourLabel(settings.sendStartHour)}–${hourLabel(settings.sendEndHour)} ET${settings.sendWeekdaysOnly ? ', Mon–Fri' : ', every day'}. ${settings.autopilot ? (win.open ? 'Sending now.' : `Waiting: ${win.reason}.`) : 'Off.'} Follow-ups go first, then new leads, spread across the day.`}>
          <SendingToggle settings={settings} setSettings={setSettings} />
        </Row>
        <Row title="Gmail inboxes only" text="Email 1 only goes to gmail.com or Google Workspace addresses. Outlook, Yahoo and other hosts are skipped: they filter cold email much harder.">
          <Switch on={settings.googleOnly !== false} onChange={v => set({ googleOnly: v })} label="Gmail inboxes only" />
        </Row>
        <Row title="Open tracking" text="Always on: every email the app sends carries an invisible image that marks it opened. Rough, since Apple Mail and mail scanners inflate it.">
          <span className="small muted">On</span>
        </Row>
        <Row title="Alert emails" text="Positive replies (wants the Loom, a call, or interested) are emailed the moment they land. Everything else (other replies, opens, reminders, paused campaigns, deliverability problems) comes in one email at 6 PM ET.">
          <input className="input input-sm alert-input" type="email" placeholder="you@gmail.com" value={settings.alertEmail ?? ''} onChange={e => set({ alertEmail: e.target.value.trim() })} />
        </Row>
      </section>

      <InboxesEditor inboxes={settings.inboxes} onInboxes={v => setSettings({ ...settings, inboxes: v })} />

      <SendingSettings settings={settings} setSettings={setSettings} />
    </div>
  )
}

function Row({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div>
        <div className="strong">{title}</div>
        <p className="small muted">{text}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={on ? 'switch on' : 'switch'} onClick={() => onChange(!on)}><span /></button>
}
