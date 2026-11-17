import { useMemo } from 'react'
import type { CampaignLead } from '../../../types'
import { groupBy, pctText, type LeadRow } from './stats'

/** Side-by-side results for each offer in a campaign (shown when its leads carry two or more offers). */
export default function OfferSplit({ members, rows }: { members: CampaignLead[]; rows: LeadRow[] }) {
  const offers = useMemo(() => {
    const leads = new Map<string, number>()
    for (const m of members) if (m.offer) leads.set(m.offer, (leads.get(m.offer) ?? 0) + 1)
    const stats = new Map(groupBy(rows.filter(r => r.m.offer), r => r.m.offer).map(s => [s.key, s]))
    return [...leads.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([offer, n]) => ({ offer, leads: n, s: stats.get(offer) }))
  }, [members, rows])
  if (offers.length < 2) return null
  return (
    <section className="card flush">
      <header className="card-head pad"><h2>Offers</h2><span className="small muted">Rates are of leads emailed. Rows under 20 emailed are greyed out (too few to trust).</span></header>
      <div className="table-scroll"><table className="table compact">
        <thead><tr>
          <th>Offer</th><th className="num">Leads</th><th className="num">Emailed</th><th className="num">Replies</th><th className="num">Reply rate</th>
          <th className="num">Positive</th><th className="num">Positive rate</th><th className="num">Want the video</th><th className="num">Booked</th>
          <th className="num">Bounce rate</th><th className="num">Said no / opted out</th>
        </tr></thead>
        <tbody>
          {offers.map(({ offer, leads, s }) => {
            const sent = s?.leads ?? 0
            return (
              <tr key={offer} className={sent < 20 ? 'low-sample' : undefined}>
                <td className="strong nowrap">{offer}</td>
                <td className="num">{leads.toLocaleString()}</td>
                <td className="num">{sent.toLocaleString()}</td>
                <td className="num">{s?.replies ?? 0}</td>
                <td className="num strong">{pctText(s?.replies ?? 0, sent)}</td>
                <td className="num">{s?.positive ?? 0}</td>
                <td className="num strong">{pctText(s?.positive ?? 0, sent)}</td>
                <td className="num">{s?.loom ?? 0}</td>
                <td className="num">{s?.booked ?? 0}</td>
                <td className="num">{pctText(s?.bounced ?? 0, sent)}</td>
                <td className="num">{s?.optedOut ?? 0}</td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </section>
  )
}
