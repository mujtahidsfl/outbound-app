import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { supabase } from '../../supabase'
import { TIME_ZONE } from '../../tracking'
import type { ColdProps } from './ColdApp'
import { when } from './data'

type Row = { id: number; run: string; inbox: string; seed: string; placement: string; error: string | null; sent_at: string | null; checked_at: string | null; created_at: string }

const LABEL: Record<string, [string, string]> = {
  inbox: ['Primary', 'badge-replied'],
  promotions: ['Promotions', 'badge-due'],
  updates: ['Updates', 'badge-due'],
  social: ['Social', 'badge-due'],
  forums: ['Forums', 'badge-due'],
  spam: ['Spam', 'badge-bad'],
  missing: ['Not delivered', 'badge-bad'],
  failed: ['Failed', 'badge-new'],
  pending: ['Checking…', 'badge-awaiting'],
}
const RANK = ['spam', 'missing', 'promotions', 'updates', 'social', 'forums', 'failed', 'pending', 'inbox']
const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' })

/** Mailboxes → Domain health: the morning seed test, where each inbox's email landed in Gmail. */
export default function SeedTest({ settings, setSettings }: Pick<ColdProps, 'settings' | 'setSettings'>) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [missingTable, setMissingTable] = useState(false)
  const [draft, setDraft] = useState((settings.seedInboxes ?? []).join('\n'))
  const [state, setState] = useState<{ busy?: string; msg?: string; error?: boolean }>({})

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('seed_tests').select('id,run,inbox,seed,placement,error,sent_at,checked_at,created_at')
      .gte('created_at', new Date(Date.now() - 14 * 864e5).toISOString()).order('created_at', { ascending: false }).limit(1000)
    setMissingTable(!!error)
    setRows((data ?? []) as Row[])
  }, [])
  useEffect(() => { load() }, [load])

  // Newest 7 runs as columns; each cell is that inbox's worst result across the seeds.
  const runs = useMemo(() => [...new Set((rows ?? []).map(r => r.run))].slice(0, 7), [rows])
  const cell = (inbox: string, run: string) => {
    const mine = (rows ?? []).filter(r => r.inbox === inbox && r.run === run)
    return mine.sort((a, b) => RANK.indexOf(a.placement) - RANK.indexOf(b.placement))[0]
  }

  const saveSeeds = () => {
    const list = [...new Set(draft.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean))]
    setSettings({ ...settings, seedInboxes: list })
    setDraft(list.join('\n'))
  }
  const run = async (action: 'seed-test' | 'seed-check') => {
    setState({ busy: action })
    const r = await api<{ sent?: number }>({ action })
    setState({
      error: !!r.error,
      msg: r.error ?? r.warning ?? (action === 'seed-test' ? `Sent ${r.sent} test emails. Results show here in about 5 minutes.` : 'Checked.'),
    })
    load()
  }

  const dirty = draft.trim() !== (settings.seedInboxes ?? []).join('\n')
  return (
    <section className="card">
      <div className="card-head">
        <h2>Inbox placement test</h2>
        <span className="row-wrap">
          <button className="btn btn-sm" onClick={() => run('seed-check')} disabled={!!state.busy || !settings.seedInboxes?.length}>{state.busy === 'seed-check' ? 'Checking…' : 'Check results now'}</button>
          <button className="btn btn-sm btn-primary" onClick={() => run('seed-test')} disabled={!!state.busy || !settings.seedInboxes?.length}>{state.busy === 'seed-test' ? 'Sending…' : 'Run test now'}</button>
        </span>
      </div>
      <p className="small muted">
        Every sending morning, an hour before sending starts, each inbox sends its real Email 1 to the Gmail accounts below. A few minutes later the app logs in to them and records where each one landed.
      </p>
      {missingTable && <p className="small due-text">Run supabase/seed.sql in Supabase to turn this on.</p>}

      <label className="field">
        <span className="small">Seed Gmail accounts (one per line)</span>
        <textarea className="input" rows={2} value={draft} onChange={e => setDraft(e.target.value)} placeholder="yourseed@gmail.com" />
        <span className="small muted">Use a Gmail that has never replied to or saved these inboxes as contacts, or Gmail will trust them more than it trusts a stranger. Each one needs a Gmail app password saved in Vercel as SEED_PASSWORD.</span>
      </label>
      <div className="row-wrap">
        <button className="btn" onClick={saveSeeds} disabled={!dirty}>Save seed accounts</button>
        {state.msg && <span className={state.error ? 'small error-text' : 'small check'}>{state.msg}</span>}
      </div>

      {runs.length > 0 && (
        <div className="table-scroll">
          <table className="table compact">
            <thead>
              <tr><th>Inbox</th>{runs.map(r => <th key={r} className="nowrap">{r.startsWith('manual-') ? `Manual · ${when.format(new Date(r.slice(7)))}` : dayLabel.format(new Date(`${r}T12:00:00Z`))}</th>)}</tr>
            </thead>
            <tbody>
              {settings.inboxes.map(inbox => (
                <tr key={inbox}>
                  <td className="small">{inbox}</td>
                  {runs.map(run => {
                    const c = cell(inbox, run)
                    if (!c) return <td key={run} className="muted small">—</td>
                    const [label, cls] = LABEL[c.placement] ?? [c.placement, 'badge-new']
                    return <td key={run}><span className={`badge ${cls}`} title={c.error ?? `${c.seed}${c.checked_at ? ` · checked ${when.format(new Date(c.checked_at))}` : ''}`}>{label}</span></td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && !runs.length && !missingTable && <p className="small muted">No tests yet.</p>}
    </section>
  )
}
