import { useState } from 'react'
import { api } from '../../api'
import { composeEmail, footerReady, inboxPersona } from '../../tracking'
import type { ColdProps } from './ColdApp'

/** A single hand-written email. As a reply to a lead it lands in the same thread, from the lead's inbox. */
export default function WriteEmail({ leads, tracks, settings, data, leadId }: ColdProps & { leadId?: string }) {
  const lead = leadId ? leads.find(l => l.id === leadId) : undefined
  const leadInbox = lead ? tracks[lead.id]?.inbox : undefined
  const [inbox, setInbox] = useState(leadInbox ?? settings.inboxes[0] ?? '')
  const [to, setTo] = useState(lead?.email ?? '')
  // Reply on the subject they actually got (campaign emails have their own), newest first.
  const lastSubject = lead ? data.messages.find(m => m.lead_id === lead.id && m.status === 'sent' && m.subject)?.subject : undefined
  const [subject, setSubject] = useState(lead ? `Re: ${(lastSubject ?? composeEmail(lead, settings, false, inbox).subject).replace(/^Re: /, '')}` : '')
  const [body, setBody] = useState(lead ? `Hi ${lead.businessName} team,\n\n\n\nBest,\n${inboxPersona(inbox)}` : '')
  const [footer, setFooter] = useState(false)
  const [state, setState] = useState<{ busy?: boolean; msg?: string; error?: boolean }>({})

  const send = async () => {
    setState({ busy: true })
    const r = await api({ action: 'send-one', inbox, to, subject, body, footer, leadId: lead?.id })
    setState(r.ok ? { msg: r.warning ?? `Sent to ${to} from ${inbox}.` } : { msg: r.error, error: true })
    if (r.ok) data.refresh()
  }

  return (
    <section className="card write-card">
      {lead && <p className="small muted">Replying to <strong>{lead.businessName}</strong>{leadInbox ? `. It goes out in the same thread from ${leadInbox}.` : '.'}</p>}
      <div className="row2">
        <label className="field">
          <span className="small">From</span>
          <select className="select" value={inbox} onChange={e => setInbox(e.target.value)} disabled={!!leadInbox}>
            {settings.inboxes.map(i => <option key={i}>{i}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="small">To</span>
          <input className="input" type="email" value={to} onChange={e => setTo(e.target.value)} placeholder="owner@business.com" />
        </label>
      </div>
      <label className="field">
        <span className="small">Subject</span>
        <input className="input" value={subject} onChange={e => setSubject(e.target.value)} />
      </label>
      <label className="field">
        <span className="small">Message</span>
        <textarea className="input textarea" rows={12} value={body} onChange={e => setBody(e.target.value)} />
      </label>
      <label className="toggle spaced">
        <input type="checkbox" checked={footer} onChange={e => setFooter(e.target.checked)} disabled={!footerReady(settings)} />
        <span className="small">Add the company footer {footerReady(settings) ? '(off by default for replies)' : '(set it in Settings first)'}</span>
      </label>
      <div className="row-wrap">
        <button className="btn btn-primary" onClick={send} disabled={state.busy || !to || !subject || !body}>{state.busy ? 'Sending…' : 'Send email'}</button>
        {state.msg && <span className={state.error ? 'small error-text' : 'small check'}>{state.msg}</span>}
      </div>
    </section>
  )
}
