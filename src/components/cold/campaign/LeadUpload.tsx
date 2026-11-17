import { useMemo, useState } from 'react'
import { Upload } from 'lucide-react'
import { api } from '../../../api'
import type { CampaignProps } from './CampaignView'
import { parseCsv, varName } from './csv'

const BATCH = 500

const ALIASES: Record<string, string[]> = {
  email: ['email', 'email_address', 'e_mail', 'work_email'],
  company: ['company', 'company_name', 'business', 'business_name', 'organization'],
  city: ['city', 'location'],
  website: ['website', 'site', 'url', 'domain', 'company_website'],
}

/** Upload a CSV, match its columns, and add the leads. Every other column becomes a {{variable}}. */
export default function LeadUpload({ campaign: c, campaigns }: CampaignProps) {
  const [table, setTable] = useState<string[][] | null>(null)
  const [file, setFile] = useState('')
  const [map, setMap] = useState<Record<string, number>>({})
  const [state, setState] = useState<{ busy?: string; msg?: string; error?: boolean }>({})
  const head = useMemo(() => (table?.[0] ?? []).map(varName), [table])

  const pick = async (f?: File) => {
    if (!f) return
    const rows = parseCsv(await f.text())
    const names = (rows[0] ?? []).map(varName)
    setTable(rows)
    setFile(f.name)
    setState({})
    setMap(Object.fromEntries(Object.entries(ALIASES).map(([k, list]) => [k, names.findIndex(n => list.includes(n))])))
  }

  const upload = async () => {
    if (!table || map.email < 0) return
    const known = new Set([map.email, map.company, map.city, map.website])
    const rows = table.slice(1).map(r => ({
      email: r[map.email] ?? '',
      company: map.company >= 0 ? r[map.company] : undefined,
      city: map.city >= 0 ? r[map.city] : undefined,
      website: map.website >= 0 ? r[map.website] : undefined,
      vars: Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']).filter(([h, v], i) => h && v && !known.has(i))),
    }))
    const total = { added: 0, skipped: 0, invalid: 0, noMail: 0 }
    for (let i = 0; i < rows.length; i += BATCH) {
      setState({ busy: `Adding ${Math.min(i + BATCH, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}…` })
      const r = await api<typeof total>({ action: 'add-leads', campaignId: c.id, rows: rows.slice(i, i + BATCH) }, '/api/campaign')
      if (r.error) return setState({ msg: `${r.error} (${total.added.toLocaleString()} added before that)`, error: true })
      total.added += r.added
      total.skipped += r.skipped
      total.invalid += r.invalid
      total.noMail += r.noMail
    }
    campaigns.reload()
    setTable(null)
    setState({ msg: `${total.added.toLocaleString()} added.${total.noMail ? ` ${total.noMail.toLocaleString()} with no mail server won't be sent to.` : ''}${total.skipped ? ` ${total.skipped.toLocaleString()} skipped: already in a campaign or already contacted.` : ''}${total.invalid ? ` ${total.invalid.toLocaleString()} not valid emails.` : ''}` })
  }

  const field = (key: string, label: string) => (
    <label className="field" key={key}>
      <span className="small">{label}</span>
      <select className="select select-sm" value={map[key] ?? -1} onChange={e => setMap({ ...map, [key]: Number(e.target.value) })}>
        <option value={-1}>Not in this file</option>
        {table?.[0].map((h, i) => <option key={i} value={i}>{h}</option>)}
      </select>
    </label>
  )

  return (
    <section className="card">
      <div className="card-head">
        <h2>Add leads</h2>
        <label className="btn btn-sm btn-primary">
          <Upload size={14} /> Upload CSV
          <input type="file" accept=".csv,text/csv" hidden onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
        </label>
      </div>
      {!table && <p className="small muted">A CSV with an email column. Every other column becomes a variable, so a "First Name" column is {'{{first_name}}'} in your emails. Domains with no mail server are marked Do not send, and anyone already emailed or in another campaign is skipped.</p>}
      {table && (
        <div className="stack-sm">
          <p className="small"><strong>{file}</strong> · {(table.length - 1).toLocaleString()} rows</p>
          <div className="grid-4">{field('email', 'Email')}{field('company', 'Company')}{field('city', 'City')}{field('website', 'Website')}</div>
          <p className="small muted">Variables from this file: {head.filter((h, i) => h && ![map.email, map.company, map.city, map.website].includes(i)).map(h => `{{${h}}}`).join(' ') || 'none'}</p>
          <div className="row-wrap">
            <button className="btn btn-primary" onClick={upload} disabled={map.email < 0 || !!state.busy}>{state.busy ?? `Add ${(table.length - 1).toLocaleString()} leads`}</button>
            <button className="btn" onClick={() => setTable(null)} disabled={!!state.busy}>Cancel</button>
            {map.email < 0 && <span className="small error-text">Pick the email column.</span>}
          </div>
        </div>
      )}
      {state.msg && <p className={state.error ? 'small error-text' : 'small check'}>{state.msg}</p>}
    </section>
  )
}
