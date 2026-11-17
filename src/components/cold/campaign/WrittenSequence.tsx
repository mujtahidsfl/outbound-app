import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '../../../api'
import { fetchLeadVars } from '../../../campaigns'
import { composeCampaignEmail, sequencePlan, templateEmails } from '../../../tracking'
import type { CampaignEmail, CampaignLead, SequenceStep } from '../../../types'
import type { CampaignProps } from './CampaignView'

const BASE_VARS = ['first_name', 'last_name', 'company', 'city', 'website', 'sender_name']
const LETTER = 'ABCDE'

/** Write the sequence: emails, the days between them, and variants of each. Saved edits reach every email not yet sent. */
export default function WrittenSequence({ campaign: c, campaigns, settings, activity }: CampaignProps) {
  const [seq, setSeq] = useState<SequenceStep[]>(c.config.sequence ?? [])
  const [variant, setVariant] = useState<Record<number, number>>({})
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>()
  const members = useMemo(() => [...campaigns.members.values()].filter(m => m.campaignId === c.id), [campaigns.members, c.id])
  const [preview, setPreview] = useState<CampaignLead | undefined>()
  const focused = useRef<{ el: HTMLTextAreaElement | HTMLInputElement; step: number; key: 'subject' | 'body' } | null>(null)
  const dirty = JSON.stringify(seq) !== JSON.stringify(c.config.sequence ?? [])
  const lead = members[0]
  const leadKey = lead?.leadId
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (leadKey) fetchLeadVars(leadKey).then(vars => setPreview({ ...lead, vars })).catch(() => setPreview(lead)) }, [leadKey])

  const vars = [...new Set([...BASE_VARS, ...Object.keys(preview?.vars ?? {})])]
  const change = (i: number, fn: (s: SequenceStep) => SequenceStep) => setSeq(list => list.map((s, j) => (j === i ? fn(s) : s)))
  const setText = (i: number, v: number, key: 'subject' | 'body', value: string) =>
    change(i, s => ({ ...s, variants: s.variants.map((x, k) => (k === v ? { ...x, [key]: value } : x)) }))
  const insert = (name: string) => {
    const f = focused.current
    if (!f) return
    const at = f.el.selectionStart ?? f.el.value.length
    const token = `{{${name}}}`
    setText(f.step, variant[f.step] ?? 0, f.key, `${f.el.value.slice(0, at)}${token}${f.el.value.slice(f.el.selectionEnd ?? at)}`)
  }
  const save = async () => {
    if (!seq[0]?.variants.every(v => v.subject.trim())) return setMsg({ text: 'Email 1 needs a subject in every variant.', error: true })
    if (seq.some(s => s.variants.some(v => !v.body.trim()))) return setMsg({ text: 'Every email needs a body in every variant.', error: true })
    const plan = sequencePlan(seq)
    // Screenshot settings belong to the email, so they stay with it.
    const steps = plan.steps.map((s, i) => ({ ...s, ...(c.steps[i]?.attachImages ? { attachImages: true } : {}) }))
    const error = await campaigns.update(c.id, { config: { ...c.config, sequence: seq }, steps, cadence: plan.cadence })
    setMsg(error ? { text: error, error: true } : { text: 'Saved.' })
  }
  const sample = (i: number) => {
    if (!preview) return null
    const draft = { ...c, config: { ...c.config, sequence: seq }, steps: sequencePlan(seq).steps }
    const inbox = c.config.inboxes?.[0] ?? settings.inboxes[0] ?? 'you@example.com'
    const emails: CampaignEmail[] = templateEmails(draft, preview, settings, (s, n) => (s === i ? Math.min(variant[i] ?? 0, n - 1) : undefined))
    return composeCampaignEmail(draft, preview, emails, i, inbox)
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Variables</h2>
          <span className="row-wrap">
            {msg && <span className={msg.error ? 'small error-text' : 'small check'}>{msg.text}</span>}
            <button className="btn btn-sm btn-primary" onClick={save} disabled={!dirty}>{dirty ? 'Save sequence' : 'Saved'}</button>
          </span>
        </div>
        <p className="small muted">Click in a subject or body, then click a variable to add it. Add a fallback for leads missing one: {'{{first_name|there}}'}. Your company line goes on every email by itself.</p>
        <div className="row-wrap">{vars.map(v => <button key={v} className="chip chip-btn" onClick={() => insert(v)}>{`{{${v}}}`}</button>)}</div>
      </section>

      {seq.map((s, i) => {
        const v = Math.min(variant[i] ?? 0, s.variants.length - 1)
        const cur = s.variants[v]
        const e = sample(i)
        return (
          <section className="card" key={i}>
            <div className="card-head">
              <h2>Email {i + 1}</h2>
              <span className="row-wrap">
                {i > 0 && (
                  <label className="row-wrap small">Wait
                    <input className="input input-sm input-num" type="number" min={1} value={s.gap} onChange={ev => change(i, x => ({ ...x, gap: Math.max(1, Number(ev.target.value) || 1) }))} aria-label={`Days before email ${i + 1}`} />
                    days after Email {i}
                  </label>
                )}
                {i > 0 && <button className="icon-btn" title="Remove this email" aria-label={`Remove email ${i + 1}`} onClick={() => setSeq(list => list.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
              </span>
            </div>
            <div className="seg-row">
              <div className="segmented" role="tablist" aria-label={`Variants of email ${i + 1}`}>
                {s.variants.map((_, k) => <button key={k} role="tab" aria-selected={k === v} className={k === v ? 'seg active' : 'seg'} onClick={() => setVariant({ ...variant, [i]: k })}>Variant {LETTER[k]}</button>)}
              </div>
              {s.variants.length < LETTER.length && <button className="btn btn-sm" onClick={() => { change(i, x => ({ ...x, variants: [...x.variants, { subject: '', body: '' }] })); setVariant({ ...variant, [i]: s.variants.length }) }}><Plus size={14} /> Add variant</button>}
              {s.variants.length > 1 && <button className="btn btn-sm" onClick={() => { change(i, x => ({ ...x, variants: x.variants.filter((_, k) => k !== v) })); setVariant({ ...variant, [i]: 0 }) }}>Remove {LETTER[v]}</button>}
            </div>
            {i === 0 ? (
              <label className="field">
                <span className="small">Subject</span>
                <input className="input" value={cur.subject} onChange={ev => setText(i, v, 'subject', ev.target.value)} onFocus={ev => { focused.current = { el: ev.target, step: i, key: 'subject' } }} />
              </label>
            ) : <p className="small muted">Replies in Email 1's thread, with "Re:" and Email 1's subject.</p>}
            <label className="field">
              <span className="small">Body</span>
              <textarea className="input textarea" rows={9} value={cur.body} onChange={ev => setText(i, v, 'body', ev.target.value)} onFocus={ev => { focused.current = { el: ev.target, step: i, key: 'body' } }} />
            </label>
            {e && cur.body.trim() && (
              <details className="seq-preview">
                <summary className="small">Preview for {preview?.businessName}</summary>
                <p className="small"><span className="muted">Subject:</span> <strong>{e.subject}</strong></p>
                <pre className="preview email-preview">{e.body}</pre>
              </details>
            )}
          </section>
        )
      })}
      <button className="btn" onClick={() => setSeq([...seq, { gap: 2, variants: [{ subject: '', body: '' }] }])}><Plus size={14} /> Add email</button>
      <TestSend {...{ c, settings, activity, leadId: lead?.leadId, steps: seq.length, dirty }} />
    </div>
  )
}

function TestSend({ c, settings, activity, leadId, steps, dirty }: { c: CampaignProps['campaign']; settings: CampaignProps['settings']; activity: CampaignProps['activity']; leadId?: string; steps: number; dirty: boolean }) {
  const [inbox, setInbox] = useState(settings.inboxes[0] ?? '')
  const [to, setTo] = useState('')
  const [step, setStep] = useState(0)
  const [state, setState] = useState<{ busy?: boolean; msg?: string; error?: boolean }>({})
  const send = async () => {
    setState({ busy: true })
    const r = await api({ action: 'campaign-test', campaignId: c.id, leadId, step, inbox, to })
    setState(r.ok ? { msg: `Sent Email ${step + 1} to ${to}. Check Primary vs Spam/Promotions.${r.warning ? ` ${r.warning}` : ''}` } : { msg: r.error, error: true })
    if (r.ok) activity.refresh()
  }
  return (
    <section className="card">
      <h2>Send yourself a test</h2>
      <p className="small muted">{leadId ? 'Sends the saved email as the first lead would get it, with [Test] in the subject.' : 'Add leads first: a test is filled in for a real lead.'}</p>
      <div className="row-wrap">
        <select className="select" value={step} onChange={e => setStep(Number(e.target.value))} aria-label="Which email">
          {Array.from({ length: steps }, (_, i) => <option key={i} value={i}>Email {i + 1}</option>)}
        </select>
        <select className="select" value={inbox} onChange={e => setInbox(e.target.value)} aria-label="Send from">
          {settings.inboxes.map(i => <option key={i}>{i}</option>)}
        </select>
        <input className="input" type="email" placeholder="your@email.com" value={to} onChange={e => setTo(e.target.value)} aria-label="Send test to" />
        <button className="btn btn-primary" onClick={send} disabled={state.busy || !to || !leadId || dirty}>{state.busy ? 'Sending…' : dirty ? 'Save first' : 'Send test'}</button>
      </div>
      {state.msg && <p className={state.error ? 'small error-text' : 'small check'}>{state.msg}</p>}
    </section>
  )
}
