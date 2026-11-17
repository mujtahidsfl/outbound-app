import { useEffect, useMemo, useState } from 'react'
import { Check as CheckIcon } from 'lucide-react'
import { api } from '../../api'
import { autoCap, dailyCapacity, footerReady, inboxCap, inboxPersona, inboxTotal, isWarmingUp, sendWindow, sentByInbox, warmupWeek } from '../../tracking'
import type { Settings } from '../../types'
import type { ColdProps } from './ColdApp'
import { when } from './data'
import { GuardRules } from './Guard'
import { etDay } from './campaign/stats'
import { Avatar } from './campaign/ui'
import { AlertsCard } from './Alerts'
import { SendingSettingsTab } from './ColdSettings'
import Deliverability from './Deliverability'
import SeedTest from './SeedTest'
import SenderDetail from './SenderDetail'

type MailTab = 'accounts' | 'settings' | 'domains' | 'activity'
const TABS: { id: MailTab; label: string }[] = [
  { id: 'accounts', label: 'Email accounts' },
  { id: 'domains', label: 'Domains' },
  { id: 'settings', label: 'Sending settings' },
  { id: 'activity', label: 'Activity' },
]

/** Email accounts, Instantly-style: the inboxes, how and when they send, their domains, and what they did. */
export default function Mailboxes(props: ColdProps) {
  const [tab, setTab] = useState<MailTab>('accounts')
  const [open, setOpen] = useState<string | null>(null)
  if (open) return <SenderDetail {...props} inbox={open} onBack={() => setOpen(null)} />
  return (
    <div className="stack">
      <nav className="tabs" aria-label="Sender accounts">
        {TABS.map(t => <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </nav>
      {tab === 'accounts' && <Accounts {...props} onOpen={setOpen} />}
      {tab === 'settings' && <><SendingSettingsTab {...props} /><TestEmail inboxes={props.settings.inboxes} onSent={props.data.refresh} /></>}
      {tab === 'domains' && <><SeedTest {...props} /><Deliverability {...props} /><section className="card"><GuardRules settings={props.settings} /></section></>}
      {tab === 'activity' && <Activity {...props} />}
    </div>
  )
}

type Check = { inbox: string; passwordSet: boolean; smtp: string; imap: string }

/** The result of "Add inbox", which api/google.ts leaves in the URL fragment when Google sends you back. */
function googleResult() {
  const p = new URLSearchParams(location.hash.slice(1))
  const inbox = p.get('inbox')
  switch (p.get('google')) {
    case 'added': return { msg: `${inbox} is connected. It starts on warm-up and joins sending on its own.` }
    case 'updated': return { msg: `${inbox} now signs in with Google.` }
    case 'error': return { msg: p.get('message') ?? 'Google sign-in failed.', error: true }
    default: return {}
  }
}

/** Email accounts: today's quota per inbox, connection checks, reply-check status. */
function Accounts({ tracks, settings, setSettings, now, data, campaigns, onOpen }: Omit<ColdProps, 'onOpen'> & { onOpen: (inbox: string) => void }) {
  const today = useMemo(() => sentByInbox(tracks, now), [tracks, now])
  const assigned = useMemo(() => {
    const c: Record<string, number> = {}
    for (const t of Object.values(tracks)) if (t.inbox) c[t.inbox] = (c[t.inbox] ?? 0) + 1
    return c
  }, [tracks])
  const bounced = useMemo(() => {
    const seen = new Set<string>()
    const c: Record<string, number> = {}
    for (const e of data.events) {
      if (e.kind !== 'bounce' || etDay(e.created_at) !== now || seen.has(`${e.inbox}|${e.lead_id}`)) continue
      seen.add(`${e.inbox}|${e.lead_id}`)
      c[e.inbox] = (c[e.inbox] ?? 0) + 1
    }
    return c
  }, [data.events, now])
  const [checks, setChecks] = useState<Record<string, Check> | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [run, setRun] = useState<{ busy?: boolean; msg?: string; error?: boolean }>(googleResult)
  const [adding, setAdding] = useState(false)
  useEffect(() => { if (location.hash.startsWith('#google=')) history.replaceState(null, '', location.pathname) }, [])

  const addInbox = async () => {
    setAdding(true)
    const r = await api<{ url?: string }>({ action: 'google-connect' })
    if (r.url) return location.assign(r.url)
    setAdding(false)
    setRun({ msg: r.error ?? 'Could not reach Google.', error: true })
  }
  const checkAll = async () => {
    setChecking(true)
    setCheckError(null)
    const r = await api<{ inboxes: Check[] }>({ action: 'check-inboxes' })
    setChecking(false)
    if (r.error) setCheckError(r.error)
    else setChecks(Object.fromEntries(r.inboxes.map(c => [c.inbox, c])))
  }
  const sendDue = async () => {
    setRun({ busy: true })
    const r = await api<{ sent?: { ok: boolean; error?: string }[]; skipped?: string }>({ action: 'send-due' })
    if (r.error) return setRun({ msg: r.error, error: true })
    if (r.skipped) return setRun({ msg: r.skipped, error: true })
    const ok = r.sent?.filter(x => x.ok).length ?? 0
    const failed = (r.sent?.length ?? 0) - ok
    setRun({ msg: `${ok} sent${failed ? `, ${failed} failed` : ''}.`, error: failed > 0 })
    data.refresh()
  }

  const capacity = dailyCapacity(settings, now)
  const sent = Object.values(today).reduce((s, c) => s + inboxTotal(c), 0)
  const unflagged = inboxTotal(today[''])
  const extra = Object.keys(today).filter(i => i && !settings.inboxes.includes(i))
  const win = sendWindow(settings)

  return (
    <div className="stack">
      <AlertsCard state={data.alerts} />

      <div className="summary-bar card">
        <div className="summary-item">
          <span className="summary-label">Sent today</span>
          <span className="summary-value">{sent.toLocaleString()} <span className="muted">/ {capacity.toLocaleString()}</span></span>
          <span className={sent >= capacity ? 'meter meter-done' : 'meter'}><span style={{ width: `${Math.min(100, (sent / Math.max(1, capacity)) * 100)}%` }} /></span>
        </div>
        <div className="summary-item">
          <span className="summary-label">Inboxes</span>
          <span className="summary-value">{settings.inboxes.length}</span>
          <span className="small muted">{settings.inboxes.filter(i => data.status?.passwords[i]).length} connected</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">Sending</span>
          <span className="summary-value">{settings.autopilot ? (win.open ? 'Live' : 'Waiting') : 'Off'}</span>
          <span className="small muted">{settings.autopilot ? (win.open ? `until ${settings.sendEndHour % 12 || 12}${settings.sendEndHour < 12 ? 'am' : 'pm'} ET` : win.reason) : 'Turn on in the top bar'}</span>
        </div>
        <div className="summary-actions">
          <button className="btn btn-sm" onClick={checkAll} disabled={checking} title="Logs in to each inbox. Sends nothing.">{checking ? 'Checking…' : 'Check connections'}</button>
          <button className="btn btn-sm" onClick={sendDue} disabled={run.busy} title="One send from every inbox now. Caps still apply.">{run.busy ? 'Sending…' : 'Send due now'}</button>
          <button className="btn btn-sm btn-primary" onClick={addInbox} disabled={adding} title="Sign in with the Google account you want to send from.">{adding ? 'Opening Google…' : 'Add inbox'}</button>
        </div>
      </div>
      {(run.msg || checkError) && <p className={run.error || checkError ? 'small error-text' : 'small check'}>{checkError ?? run.msg}</p>}
      {unflagged > 0 && <p className="small due-text">{unflagged} email{unflagged === 1 ? '' : 's'} sent today {unflagged === 1 ? 'has' : 'have'} no inbox set.</p>}

      <section className="card flush">
        <div className="table-scroll">
          <table className="table list-table">
            <thead>
              <tr><th>Account</th><th>Status</th><th>Sent today</th><th title="How many this account sends today. Blank follows the warm-up ramp. Resets tomorrow.">Limit today</th><th className="num">Bounced today</th><th>Connection</th><th>Replies checked</th><th className="num">Leads</th></tr>
            </thead>
            <tbody>
              {[...settings.inboxes, ...extra].map(i => {
                const n = inboxTotal(today[i])
                const cap = inboxCap(settings, i, now)
                const st = data.states[i]
                const has = data.status?.passwords[i]
                return (
                  <tr key={i} className="row-link" onClick={() => onOpen(i)}>
                    <td>
                      <span className="who">
                        <Avatar inbox={i} />
                        <span><span>{inboxPersona(i)}{isWarmingUp(settings, i, now) && <span className="chip">warm-up wk {warmupWeek(settings, now, i) + 1}</span>}</span><small>{i}</small></span>
                      </span>
                    </td>
                    <td>
                      {!data.status ? <span className="pill pill-muted">…</span>
                        : !has ? <span className="pill pill-muted">Not connected</span>
                        : st?.error ? <span className="pill pill-bad" title={st.error}><i />Error</span>
                        : <span className="pill pill-good"><i />Active</span>}
                    </td>
                    <td>
                      <span className="inline-meter">
                        <span className={n > cap ? 'meter meter-over' : n >= cap ? 'meter meter-done' : 'meter'}><span style={{ width: `${Math.min(100, (n / Math.max(1, cap)) * 100)}%` }} /></span>
                        <span className="small strong nowrap">{n} / {cap}</span>
                      </span>
                    </td>
                    <td onClick={e => e.stopPropagation()}><TodayLimit settings={settings} setSettings={setSettings} inbox={i} now={now} /></td>
                    <td className="num">{bounced[i] ?? 0}</td>
                    <td><ConnectionCell check={checks?.[i]} /></td>
                    <td className="small nowrap">{st?.error ? <span className="error-text" title={st.error}>Failed</span> : st?.checked_at ? <span className="muted">{when.format(new Date(st.checked_at))}</span> : <span className="muted">—</span>}</td>
                    <td className="num">{(assigned[i] ?? 0).toLocaleString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <Checklist settings={settings} data={data} campaigns={campaigns} />
    </div>
  )
}

/** Today's send count for one account, typed in by hand. Blank goes back to the warm-up ramp; tomorrow it's automatic again. */
function TodayLimit({ settings, setSettings, inbox, now }: { settings: Settings; setSettings: (s: Settings) => void; inbox: string; now: string }) {
  const set = settings.sendsToday?.[inbox]
  const saved = set?.day === now ? String(set.n) : ''
  const auto = autoCap(settings, inbox, now)
  const [text, setText] = useState(saved)
  useEffect(() => setText(saved), [saved])
  const save = () => {
    const v = text.trim()
    if (v === saved) return
    const n = Number(v)
    if (v && !(Number.isInteger(n) && n >= 0)) return setText(saved)
    // Only today's entries are kept: yesterday's numbers drop off on the next save.
    const next = Object.fromEntries(Object.entries(settings.sendsToday ?? {}).filter(([k, x]) => k !== inbox && x.day === now))
    if (v) next[inbox] = { day: now, n }
    setSettings({ ...settings, sendsToday: next })
  }
  return (
    <span className="row-wrap nowrap">
      <input
        type="number" min={0} className="input input-sm num-input" value={text} placeholder={String(auto)}
        onChange={e => setText(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
        aria-label={`Emails ${inbox} sends today`} title={saved ? `Set by hand for today. Clear it to go back to ${auto}.` : `Automatic: ${auto} today. Type a number to change today only.`}
      />
      <span className="small muted">{saved ? 'today only' : 'auto'}</span>
    </span>
  )
}

function Checklist({ settings, data, campaigns }: Pick<ColdProps, 'settings' | 'data' | 'campaigns'>) {
  const active = campaigns.campaigns.filter(c => c.status === 'active')
  const needShots = campaigns.campaigns.some(c => c.steps.some(st => st.attachImages) && !c.images.length)
  const passwordsSet = settings.inboxes.filter(i => data.status?.passwords[i]).length
  const dkimOk = data.domains ? data.domains.every(d => d.dkimSelector) : false
  const scheduleOk = Object.values(data.states).some(st => st.checked_at && Date.now() - new Date(st.checked_at).getTime() < 15 * 60_000)
  const items: [boolean, string][] = [
    [!!data.status?.ok, 'Add the server keys in Vercel (turns sending on)'],
    [passwordsSet === settings.inboxes.length && settings.inboxes.length > 0, `Connect every inbox with Add inbox (${passwordsSet} of ${settings.inboxes.length})`],
    [dkimOk, 'Turn on DKIM for every sending domain'],
    [footerReady(settings), 'Set your company name and real mailing address for the footer'],
    [scheduleOk, 'Start the 5-minute schedule (run autopilot_cron.sql)'],
    [data.messages.some(m => m.source === 'test' && m.status === 'sent'), 'Send yourself a test email'],
    [active.length > 0, 'Activate a campaign (Campaigns)'],
    [!needShots, 'Upload the screenshots before resuming follow-ups (Campaigns → Screenshots)'],
    [settings.autopilot, 'Turn sending on'],
  ]
  if (items.every(([ok]) => ok)) return null
  return (
    <section className="card">
      <h2>Go-live checklist</h2>
      <div className="checklist">
        {items.map(([ok, text]) => (
          <div key={text} className="checkrow">
            <span className={ok ? 'ck done' : 'ck todo'}>{ok && <CheckIcon size={14} strokeWidth={3} />}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

const KIND: Record<string, string> = {
  sent: 'badge-replied', test: 'badge-awaiting', failed: 'badge-bad', reply: 'badge-awaiting',
  unsubscribe: 'badge-new', auto: 'badge-new', bounce: 'badge-bad',
}

/** The latest sends, failures, replies and bounces across every inbox. */
function Activity({ data }: ColdProps) {
  const recent = [
    ...data.messages.map(m => ({ key: `m${m.id}`, at: m.created_at, kind: m.status === 'failed' ? 'failed' : m.source === 'test' ? 'test' : 'sent', text: `${m.status === 'failed' ? `Failed to send${m.error ? ` (${m.error})` : ''}` : 'Sent'} ${m.source === 'test' ? 'test email' : m.step ? `follow-up ${m.step}` : 'first email'} to ${m.to_email} from ${m.inbox}` })),
    ...data.events.map(e => ({ key: `e${e.id}`, at: e.created_at, kind: e.kind, text: `${{ reply: 'Reply', unsubscribe: 'Unsubscribe', auto: 'Auto-reply', bounce: 'Bounce' }[e.kind] ?? e.kind} from ${e.from_email ?? 'unknown'}${e.subject ? `: ${e.subject}` : ''}` })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100)
  return (
    <section className="card flush">
      <div className="table-scroll"><table className="table">
        <thead><tr><th>When</th><th>Type</th><th>What</th></tr></thead>
        <tbody>
          {recent.map(r => (
            <tr key={r.key}>
              <td className="small muted nowrap">{when.format(new Date(r.at))}</td>
              <td><span className={`badge ${KIND[r.kind] ?? 'badge-new'}`}>{r.kind}</span></td>
              <td className="small">{r.text}</td>
            </tr>
          ))}
          {!recent.length && <tr><td colSpan={3} className="muted small">{data.loadError ? `Couldn't load: ${data.loadError}` : 'Nothing has happened yet.'}</td></tr>}
        </tbody>
      </table></div>
    </section>
  )
}

function ConnectionCell({ check }: { check?: Check }) {
  if (!check) return <span className="muted small">Not checked</span>
  if (!check.passwordSet) return <span className="small due-text" title={check.smtp}>Not connected</span>
  if (check.smtp === 'ok' && check.imap === 'ok') return <span className="small check">✓ Connected</span>
  const problem = check.smtp !== 'ok' ? `Sending: ${check.smtp}` : `Reading: ${check.imap}`
  return <span className="small error-text" title={problem}>✕ {problem.length > 48 ? `${problem.slice(0, 48)}…` : problem}</span>
}

function TestEmail({ inboxes, onSent }: { inboxes: string[]; onSent: () => void }) {
  const [inbox, setInbox] = useState('all')
  const [to, setTo] = useState('')
  const [state, setState] = useState<{ busy?: boolean; msg?: string; error?: boolean; results?: { inbox: string; ok: boolean; error?: string; warning?: string }[] }>({})
  const send = async () => {
    setState({ busy: true })
    const r = await api<{ results?: { inbox: string; ok: boolean; error?: string; warning?: string }[] }>({ action: 'test-email', inbox, to })
    const sent = r.results?.filter(x => x.ok).length ?? 0
    setState({
      results: r.results,
      error: !r.ok,
      msg: r.results
        ? `${sent} of ${r.results.length} sent to ${to}. Check that inbox, including Spam and Promotions.`
        : r.error,
    })
    if (sent) onSent()
  }
  return (
    <section className="card">
      <h2>Send a test email</h2>
      <p className="small muted">Sends the first-email template, filled in for a real lead, to your own address. Use it to check the inboxes work and where the emails land.</p>
      <div className="row-wrap">
        <select className="select" value={inbox} onChange={e => setInbox(e.target.value)} aria-label="Send from">
          <option value="all">All {inboxes.length} inboxes (one email each)</option>
          {inboxes.map(i => <option key={i}>{i}</option>)}
        </select>
        <input className="input" type="email" placeholder="your@email.com" value={to} onChange={e => setTo(e.target.value)} aria-label="Send test to" />
        <button className="btn btn-primary" onClick={send} disabled={state.busy || !to}>{state.busy ? 'Sending…' : 'Send test'}</button>
      </div>
      {state.msg && <p className={state.error ? 'small error-text' : 'small check'}>{state.msg}</p>}
      {state.results && state.results.length > 1 && (
        <ul className="test-results">
          {state.results.map(r => (
            <li key={r.inbox} className="small">
              {r.ok ? <span className="check">✓</span> : <span className="error-text">✕</span>} {r.inbox}
              {r.error && <span className="error-text"> · {r.error}</span>}
              {r.warning && <span className="muted"> · {r.warning}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
