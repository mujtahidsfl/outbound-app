import { useMemo } from 'react'
import { STAGE_LABEL, inboxPersona, today } from '../../../tracking'
import type { CampaignProps } from './CampaignView'
import {
  DIMENSIONS, INTENT_LABEL, buildRows, groupBy, intentCounts, pctText, replyHours, replySpeed, stepStats, subjectStats, totals,
} from './stats'
import { StackedBars, StatTable, csvCell, download, emailLabel } from './ui'
import OfferSplit from './OfferSplit'

/** Everything the campaign can tell you: subjects, which email got the reply, timing, intent, and every breakdown. */
export default function Analytics({ campaign: c, campaigns, tracks, activity }: CampaignProps) {
  const members = useMemo(() => [...campaigns.members.values()].filter(m => m.campaignId === c.id), [campaigns.members, c.id])
  const rows = useMemo(() => buildRows(members, tracks, activity.messages, activity.events), [members, tracks, activity.messages, activity.events])
  const t = totals(rows)
  const steps = stepStats(rows, c.steps.length)
  const speed = replySpeed(rows)
  const hours = replyHours(rows)
  const intents = intentCounts(rows)
  const newThreads = c.steps.map((s, i) => ({ s, i })).filter(x => x.s.thread === 'new')

  const exportLeads = () => {
    const cols = ['lead_no', 'business', 'trade', 'city', 'send_status', 'approved', 'tier', 'price', 'rating', 'reviews', 'icebreaker',
      'subject_noun', 'subject_owner', 'to_email', 'inbox', 'sender', 'emails_sent', 'email1_subject', 'email1_variant', 'email1_sent_at',
      'email2_subject', 'email2_variant', 'last_sent_at', 'opened', 'emails_opened', 'times_opened', 'first_opened_at', 'replied', 'replied_to_email', 'replied_after_n_emails', 'hours_to_reply',
      'reply_intent', 'reply_snippet', 'bounced', 'opted_out', 'stage', 'booked', 'won', 'deal_value']
    const byLead = new Map(rows.map(r => [r.m.leadId, r]))
    const lines = members.map(m => {
      const r = byLead.get(m.leadId)
      const e1 = r?.sent.find(s => s.step === 0), e2 = r?.sent.find(s => s.step === 1)
      const tr = tracks[m.leadId]
      return [m.leadNo, m.businessName, m.trade, m.city, m.sendStatus, m.approved, m.tier, m.price, m.rating, m.reviews, m.icebreaker,
        m.subjectNoun, m.subjectOwner, m.toEmail, r?.inbox, r?.inbox ? inboxPersona(r.inbox) : '', r?.sent.length ?? 0,
        e1?.subject, e1?.subject_variant, e1?.sent_at, e2?.subject, e2?.subject_variant, r?.sent.at(-1)?.sent_at,
        r?.opened ? 'yes' : '', r?.sent.filter(s => s.opened_at).map(s => s.step + 1).join(' '), r?.sent.reduce((n, s) => n + (s.open_count ?? 0), 0) || '',
        r?.sent.map(s => s.opened_at).filter(Boolean).sort()[0],
        r?.reply ? 'yes' : '', r?.replyStep != null ? r.replyStep + 1 : '', r?.afterN, r?.hoursToReply?.toFixed(1), r?.intent ? INTENT_LABEL[r.intent] : '',
        r?.reply?.snippet, r?.bounced ? 'yes' : '', r?.optedOut ? 'yes' : '', tr?.stage ? STAGE_LABEL[tr.stage] : '', r?.booked ? 'yes' : '',
        r?.won ? 'yes' : '', tr?.dealValue].map(csvCell).join(',')
    })
    download(`${c.id}-leads-${today()}.csv`, [cols.join(','), ...lines].join('\n'), 'text/csv')
  }
  const exportEmails = () => {
    const cols = ['id', 'lead_id', 'email', 'inbox', 'to', 'subject', 'variant', 'attachments', 'status', 'source', 'sent_at', 'tracked', 'opened_at', 'open_count', 'error']
    const lines = activity.messages.map(m => [m.id, m.lead_id, m.step + 1, m.inbox, m.to_email, m.subject, m.subject_variant, m.attachments, m.status, m.source, m.sent_at, m.tracked ? 'yes' : '', m.opened_at, m.open_count, m.error].map(csvCell).join(','))
    download(`${c.id}-emails-${today()}.csv`, [cols.join(','), ...lines].join('\n'), 'text/csv')
  }

  return (
    <div className="stack">
      <div className="row-wrap">
        <button className="btn btn-sm" onClick={exportLeads}>Export leads + outcomes (CSV)</button>
        <button className="btn btn-sm" onClick={exportEmails}>Export every email sent (CSV)</button>
        <span className="small muted">{t.leads.toLocaleString()} contacted · {t.opened} opened · {t.replies} replies · rows under 20 leads are greyed out (too few to trust).</span>
      </div>

      <OfferSplit members={members} rows={rows} />

      <div className="grid-2">
        {newThreads.map(({ s, i }) => {
          const subj = subjectStats(rows, i)
          return (
            <section className="card" key={s.n}>
              <header className="card-head"><h2>Subject lines · Email {s.n}</h2></header>
              <p className="small muted cold-p">Open % is of emails sent with open tracking. {i === 0 ? 'Replies to Email 1.' : `Replies anywhere in the thread Email ${s.n} starts.`} Business names are swapped for {'{name}'} so wording can be compared.</p>
              <div className="table-scroll"><table className="table compact">
                <thead><tr><th>Wording</th><th className="num">Sent</th><th className="num">Open %</th><th className="num">Replies</th><th className="num">Reply %</th><th className="num">Positive %</th></tr></thead>
                <tbody>
                  {subj.map(x => (
                    <tr key={x.key} title={`e.g. ${x.example}`} className={x.sent < 20 ? 'low-sample' : undefined}>
                      <td className="small">{x.key}</td><td className="num">{x.sent}</td><td className="num">{pctText(x.opened, x.tracked)}</td><td className="num">{x.replies}</td>
                      <td className="num strong">{pctText(x.replies, x.sent)}</td><td className="num">{pctText(x.positive, x.sent)}</td>
                    </tr>
                  ))}
                  {!subj.length && <tr><td colSpan={6} className="empty">Nothing sent yet.</td></tr>}
                </tbody>
              </table></div>
            </section>
          )
        })}
      </div>

      <div className="grid-2">
        <section className="card">
          <header className="card-head"><h2>Which email got the reply</h2></header>
          <table className="table compact">
            <thead><tr><th>Email</th><th className="num">Sent</th><th className="num">Open %</th><th className="num">Replied to it</th><th className="num">Rate</th><th className="num">Replied after it</th><th className="num">Share of replies</th></tr></thead>
            <tbody>
              {steps.map(s => (
                <tr key={s.step}>
                  <td className="strong">{emailLabel(s.step)}</td><td className="num">{s.sent}</td><td className="num">{pctText(s.opened, s.tracked)}</td><td className="num">{s.replies}</td>
                  <td className="num strong">{pctText(s.replies, s.sent)}</td><td className="num">{s.repliedAfter}</td>
                  <td className="num">{pctText(s.repliedAfter, t.replies)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">"Replied after it": this was the latest email they had when they wrote back. Shows how much each follow-up adds.</p>
        </section>

        <section className="card">
          <header className="card-head"><h2>What replies say</h2></header>
          <table className="table compact">
            <tbody>
              {(Object.keys(intents) as (keyof typeof intents)[]).map(k => (
                <tr key={k}><td>{INTENT_LABEL[k]}</td><td className="num strong">{intents[k]}</td><td className="num muted">{pctText(intents[k], t.replies)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Sorted automatically from the reply text ("Loom", "no", questions…). Fix any on the Replies page; set call booked / won on each lead.</p>
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <header className="card-head"><h2>How fast people reply</h2><span className="small muted">{speed.median != null ? `Median ${speed.median < 24 ? `${speed.median.toFixed(1)} h` : `${(speed.median / 24).toFixed(1)} days`} after Email 1` : ''}</span></header>
          <StackedBars labels={speed.buckets.map(([l]) => l)} series={[{ name: 'Replies', cls: 'fill-s1', values: speed.buckets.map(([, n]) => n) }]} height={170} empty="No replies yet." />
        </section>
        <section className="card">
          <header className="card-head"><h2>When replies arrive (ET)</h2></header>
          <StackedBars labels={hours.map(h => h.label)} series={[{ name: 'Replies', cls: 'fill-s2', values: hours.map(h => h.n) }]} height={170} empty="No replies yet." />
        </section>
      </div>

      <div className="grid-2">
        {DIMENSIONS.map(d => <StatTable key={d.id} title={d.label} rows={groupBy(rows, d.key)} />)}
      </div>
    </div>
  )
}
