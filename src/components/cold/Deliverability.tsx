import { useState } from 'react'
import { CircleCheck } from 'lucide-react'
import { api } from '../../api'
import type { ColdProps } from './ColdApp'
import { Found } from './ColdDashboard'
import type { DomainCheck } from './data'

const MODE: Record<DomainCheck['mode'], string> = { green: 'badge-replied', yellow: 'badge-due', red: 'badge-bad' }

/** SPF / DKIM / DMARC / MX for every sending domain, plus a check for any other domain. */
export default function Deliverability({ data }: ColdProps) {
  const [domain, setDomain] = useState('')
  const [selector, setSelector] = useState('')
  const [extra, setExtra] = useState<DomainCheck[]>([])
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({})

  const check = async () => {
    setState({ busy: true })
    const r = await api<{ domains: DomainCheck[] }>({ action: 'deliverability', domain, selector: selector || undefined })
    if (r.error) return setState({ error: r.error })
    setState({})
    setExtra(prev => [...r.domains, ...prev.filter(d => d.domain !== r.domains[0]?.domain)])
  }

  return (
    <div className="stack">
      <div className="row-wrap">
        <button className="btn" onClick={data.checkDomains}>Re-check my domains</button>
        {data.domainsError && <span className="small error-text">{data.domainsError}</span>}
      </div>
      {data.domains === null && !data.domainsError && <p className="muted small">Checking your domains…</p>}
      {[...extra, ...(data.domains ?? [])].map(d => <DomainCard key={d.domain} d={d} />)}

      <section className="card">
        <h2>Check another domain</h2>
        <div className="row2">
          <label className="field">
            <span className="small">Domain</span>
            <input className="input" value={domain} onChange={e => setDomain(e.target.value)} placeholder="yourdomain.com" />
          </label>
          <label className="field">
            <span className="small">DKIM selector (optional)</span>
            <input className="input" value={selector} onChange={e => setSelector(e.target.value)} placeholder="e.g. default" />
          </label>
        </div>
        <div className="row-wrap">
          <button className="btn btn-primary" onClick={check} disabled={state.busy || !domain.trim()}>{state.busy ? 'Checking…' : 'Check domain'}</button>
          {state.error && <span className="small error-text">{state.error}</span>}
        </div>
      </section>
    </div>
  )
}

function DomainCard({ d }: { d: DomainCheck }) {
  const unknown = (part: string) => !!d.unchecked?.includes(part)
  return (
    <section className="card">
      <div className="card-head">
        <h2>{d.domain}</h2>
        <span className="row-wrap">
          <span className={`badge ${MODE[d.mode]}`}>{d.label}</span>
          <span className="small">Score <strong>{d.score}/100</strong> · suggested limit {d.cap ? `${d.cap}/day per inbox` : 'normal paced sending'}</span>
        </span>
      </div>
      <div className="grid-2">
        <table className="table compact">
          <tbody>
            <tr><td>SPF (allowed senders)</td><td className="num"><Found ok={!!d.spf && !!d.spfCoversSending} unknown={unknown('SPF')} /></td></tr>
            <tr><td>DKIM (signature){d.dkimSelector && <span className="small muted"> · selector “{d.dkimSelector}”</span>}</td><td className="num"><Found ok={!!d.dkimSelector} unknown={unknown('DKIM')} /></td></tr>
            <tr><td>DMARC (policy){d.dmarcPolicy && <span className="small muted"> · {d.dmarcPolicy}</span>}</td><td className="num"><Found ok={!!d.dmarc} unknown={unknown('DMARC')} /></td></tr>
            <tr><td>MX (mail servers)</td><td className="num"><Found ok={d.mx.length > 0} unknown={unknown('MX')} /></td></tr>
          </tbody>
        </table>
        <div>
          <h3>What to fix</h3>
          {d.issues.length
            ? <ul className="fix-list">{d.issues.map(i => <li key={i}>{i}</li>)}</ul>
            : <p className="check row-wrap"><CircleCheck size={18} /> No issues found</p>}
        </div>
      </div>
    </section>
  )
}
