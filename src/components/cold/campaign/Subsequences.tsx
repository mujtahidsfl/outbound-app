import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { SUBSEQUENCE_TRIGGERS, type Subsequence, type SubsequenceTrigger } from '../../../types'
import { Switch } from '../ColdSettings'
import type { CampaignProps } from './CampaignView'

const TRIGGER: Record<SubsequenceTrigger, string> = {
  interested: 'They replied: interested',
  meeting: 'They replied: wants a call',
  question: 'They replied: a question',
  other: 'They replied: anything else',
  finished: 'Finished the sequence, no reply',
  opened: 'Opened, no reply',
  clicked: 'Clicked a link, no reply',
}

/** Follow-ups that start on what a lead does, sent in the same thread from the same account. */
export default function Subsequences({ campaign: c, actions: a }: CampaignProps) {
  const [list, setList] = useState<Subsequence[]>(c.config.subsequences ?? [])
  const [msg, setMsg] = useState<string>()
  const dirty = JSON.stringify(list) !== JSON.stringify(c.config.subsequences ?? [])
  const change = (i: number, patch: Partial<Subsequence>) => setList(l => l.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const save = async () => {
    if (list.some(s => !s.name.trim() || s.steps.some(x => !x.body.trim()))) return setMsg('Each subsequence needs a name and every email needs a body.')
    setMsg(await a.saveConfig({ subsequences: list }) ?? 'Saved.')
  }
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Subsequences</h2>
          <span className="row-wrap">
            {msg && <span className="small muted">{msg}</span>}
            <button className="btn btn-sm" onClick={() => setList([...list, { id: crypto.randomUUID(), name: '', trigger: 'interested', enabled: true, steps: [{ gap: 2, body: '' }] }])}><Plus size={14} /> Add subsequence</button>
            <button className="btn btn-sm btn-primary" onClick={save} disabled={!dirty}>{dirty ? 'Save' : 'Saved'}</button>
          </span>
        </div>
        <p className="small muted">The main sequence stops for anyone who enters one, and any reply, opt-out or bounce ends it. Loom requests and "no" replies have their own paths, and a bounced address can't receive anything, so neither starts one.</p>
      </section>
      {list.map((s, i) => (
        <section className="card" key={s.id}>
          <div className="row2">
            <label className="field"><span className="small">Name</span><input className="input" value={s.name} onChange={e => change(i, { name: e.target.value })} placeholder="e.g. Interested, no Loom yet" /></label>
            <label className="field">
              <span className="small">Starts when</span>
              <select className="select" value={s.trigger} onChange={e => change(i, { trigger: e.target.value as SubsequenceTrigger })}>
                {SUBSEQUENCE_TRIGGERS.map(t => <option key={t} value={t}>{TRIGGER[t]}</option>)}
              </select>
            </label>
          </div>
          {s.steps.map((x, k) => (
            <div className="sub-step" key={k}>
              <label className="row-wrap small">Wait
                <input className="input input-sm input-num" type="number" min={0} value={x.gap} onChange={e => change(i, { steps: s.steps.map((y, j) => (j === k ? { ...y, gap: Math.max(0, Number(e.target.value) || 0) } : y)) })} aria-label="Days to wait" />
                days, then send
                {s.steps.length > 1 && <button className="icon-btn" title="Remove this email" aria-label="Remove this email" onClick={() => change(i, { steps: s.steps.filter((_, j) => j !== k) })}><Trash2 size={14} /></button>}
              </label>
              <textarea className="input textarea" rows={5} value={x.body} onChange={e => change(i, { steps: s.steps.map((y, j) => (j === k ? { ...y, body: e.target.value } : y)) })} aria-label={`Email ${k + 1}`} placeholder="Hi {{first_name|there}}," />
            </div>
          ))}
          <div className="row-wrap">
            <button className="btn btn-sm" onClick={() => change(i, { steps: [...s.steps, { gap: 3, body: '' }] })}><Plus size={14} /> Add email</button>
            <span className="spacer" />
            <span className="row-wrap small">On <Switch on={s.enabled} onChange={v => change(i, { enabled: v })} label="Subsequence on" /></span>
            <button className="btn btn-sm" onClick={() => setList(list.filter((_, j) => j !== i))}>Remove</button>
          </div>
        </section>
      ))}
    </div>
  )
}
