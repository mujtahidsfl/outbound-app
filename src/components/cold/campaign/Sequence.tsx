import { useEffect, useMemo, useState } from 'react'
import { api } from '../../../api'
import { fetchCampaignEmails } from '../../../campaigns'
import { composeCampaignEmail, fillSubjectB } from '../../../tracking'
import type { CampaignEmail, CampaignStep } from '../../../types'
import type { CampaignProps } from './CampaignView'
import { buildRows, pctText, subjectStats } from './stats'

/** The four emails: timing, threading, screenshots, subject B tests, a live preview for any lead, and a test send. */
export default function Sequence(props: CampaignProps) {
  const { campaign: c, campaigns, tracks, settings, activity } = props
  const members = useMemo(() => [...campaigns.members.values()].filter(m => m.campaignId === c.id), [campaigns.members, c.id])
  const rows = useMemo(() => buildRows(members, tracks, activity.messages, activity.events), [members, tracks, activity.messages, activity.events])
  const [q, setQ] = useState('')
  const [leadId, setLeadId] = useState(members[0]?.leadId)
  const lead = members.find(m => m.leadId === leadId) ?? members[0]
  const inbox = (lead && tracks[lead.leadId]?.inbox) || settings.inboxes[0]
  const [emails, setEmails] = useState<CampaignEmail[] | null>(null)
  const [loadError, setLoadError] = useState<string>()
  const [msg, setMsg] = useState<string>()

  const leadKey = lead?.leadId
  useEffect(() => {
    if (!leadKey) return
    let cancelled = false
    setEmails(null)
    fetchCampaignEmails(leadKey).then(e => !cancelled && setEmails(e)).catch(e => !cancelled && setLoadError(String(e.message ?? e)))
    return () => { cancelled = true }
  }, [leadKey])

  const matches = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? members.filter(m => `${m.businessName} ${m.city} ${m.trade}`.toLowerCase().includes(n)).slice(0, 30) : []
  }, [members, q])

  const setStep = async (i: number, patch: Partial<CampaignStep>) =>
    setMsg(await campaigns.update(c.id, { steps: c.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }))
  const setSubjectB = async (n: number, v: string) => {
    const next = { ...c.subjectB }
    if (v.trim()) next[String(n)] = v
    else delete next[String(n)]
    setMsg(await campaigns.update(c.id, { subjectB: next }))
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Preview as a lead</h2>
          <span className="small muted">{lead ? <>Showing <strong>{lead.businessName}</strong> · {lead.trade} · {lead.city} · {lead.sendStatus}, signed from {inbox}</> : 'No leads'}</span>
        </div>
        <div className="row-wrap">
          <input className="input search" placeholder="Search a business to preview…" value={q} onChange={e => setQ(e.target.value)} />
          {matches.length > 0 && (
            <select className="select" value="" onChange={e => { setLeadId(e.target.value); setQ('') }} aria-label="Pick a lead">
              <option value="">{matches.length} match{matches.length === 1 ? '' : 'es'}…</option>
              {matches.map(m => <option key={m.leadId} value={m.leadId}>{m.businessName} · {m.city}</option>)}
            </select>
          )}
        </div>
        {loadError && <p className="small error-text">{loadError}</p>}
        {lead && lead.checks.length > 0 && (
          <ul className="fix-list small">{lead.checks.map(x => <li key={x}>Check: {x}</li>)}</ul>
        )}
      </section>

      {c.steps.map((s, i) => {
        const e = emails && lead ? composeCampaignEmail(c, lead, emails, i, inbox) : null
        const newThread = s.thread === 'new'
        const subj = newThread ? subjectStats(rows, i) : []
        const b = c.subjectB[String(s.n)] ?? ''
        return (
          <section className="card" key={s.n}>
            <div className="card-head">
              <h2>Email {s.n} <span className="muted small">· Day {s.day} · {newThread ? 'new thread' : `reply in Email ${s.replyTo} thread`}{i > 0 && c.followUpsPaused ? ' · paused' : ''}</span></h2>
              <label className="toggle">
                <input type="checkbox" checked={!!s.attachImages} onChange={ev => setStep(i, { attachImages: ev.target.checked })} />
                <span className="small">Attach screenshots ({c.images.length})</span>
              </label>
            </div>
            {e ? (
              <>
                <p className="small"><span className="muted">Subject:</span> <strong>{e.subject}</strong>{e.variant === 'B' && <span className="chip">B</span>}</p>
                <pre className="preview email-preview">{e.body}</pre>
                {s.attachImages && <p className="small muted">📎 {c.images.length ? c.images.map(x => x.name).join(', ') : 'No screenshots uploaded yet: this email won\'t send until you add them.'}</p>}
              </>
            ) : <p className="muted small">Loading…</p>}

            {newThread && (
              <div className="ab-box">
                <label className="field">
                  <span className="small">Subject B test (optional): half the leads get this instead. Use {'{name}'}, {'{owner}'}, {'{noun}'}, {'{city}'}, {'{trade}'}.</span>
                  <input className="input" defaultValue={b} placeholder={i === 0 ? 'e.g. {name} + more {noun}?' : 'e.g. {name}, saw this?'} onBlur={ev => ev.target.value !== b && setSubjectB(s.n, ev.target.value)} />
                </label>
                {b && lead && <p className="small muted">Example: {fillSubjectB(b, lead)}</p>}
                {subj.length > 0 && (
                  <table className="table compact">
                    <thead><tr><th>Subject wording</th><th className="num">Sent</th><th className="num">Replies</th><th className="num">Reply %</th><th className="num">Positive</th></tr></thead>
                    <tbody>
                      {subj.map(x => (
                        <tr key={x.key} title={x.example}>
                          <td className="small">{x.key}</td>
                          <td className="num">{x.sent}</td>
                          <td className="num">{x.replies}</td>
                          <td className="num strong">{pctText(x.replies, x.sent)}</td>
                          <td className="num">{x.positive}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        )
      })}
      {msg && <p className="small error-text">{msg}</p>}
      <TestSend {...props} leadId={lead?.leadId} />
    </div>
  )
}

function TestSend({ campaign: c, settings, activity, leadId }: CampaignProps & { leadId?: string }) {
  const [inbox, setInbox] = useState(settings.inboxes[0] ?? '')
  const [to, setTo] = useState('')
  const [step, setStep] = useState(0)
  const [state, setState] = useState<{ busy?: boolean; msg?: string; error?: boolean }>({})
  const send = async () => {
    setState({ busy: true })
    const r = await api<{ attachments?: number }>({ action: 'campaign-test', campaignId: c.id, leadId, step, inbox, to })
    setState(r.ok
      ? { msg: `Sent Email ${step + 1} to ${to}${r.attachments ? ` with ${r.attachments} screenshot${r.attachments === 1 ? '' : 's'}` : ''}. Check Primary vs Spam/Promotions.${r.warning ? ` ${r.warning}` : ''}` }
      : { msg: r.error, error: true })
    if (r.ok) activity.refresh()
  }
  return (
    <section className="card">
      <h2>Send yourself a test</h2>
      <p className="small muted">Sends the email exactly as the lead above would get it (subject marked [Test]), including screenshots. It doesn't count toward the campaign.</p>
      <div className="row-wrap">
        <select className="select" value={step} onChange={e => setStep(Number(e.target.value))} aria-label="Which email">
          {c.steps.map((s, i) => <option key={s.n} value={i}>Email {s.n}</option>)}
        </select>
        <select className="select" value={inbox} onChange={e => setInbox(e.target.value)} aria-label="Send from">
          {settings.inboxes.map(i => <option key={i}>{i}</option>)}
        </select>
        <input className="input" type="email" placeholder="your@email.com" value={to} onChange={e => setTo(e.target.value)} aria-label="Send test to" />
        <button className="btn btn-primary" onClick={send} disabled={state.busy || !to}>{state.busy ? 'Sending…' : 'Send test'}</button>
      </div>
      {state.msg && <p className={state.error ? 'small error-text' : 'small check'}>{state.msg}</p>}
    </section>
  )
}
