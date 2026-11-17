import { useMemo, useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { api } from '../../api'
import { derive } from '../../tracking'
import type { Campaign } from '../../types'
import type { ColdProps } from './ColdApp'
import CampaignView from './campaign/CampaignView'
import { pctText } from './campaign/stats'
import { Segmented } from './campaign/ui'

type View = 'all' | 'active' | 'paused' | 'done'

/** Every campaign, filterable by status, folder and name. Click a row to open it; "Create campaign" starts a new one. */
export default function Campaigns(props: ColdProps) {
  const { campaigns } = props
  const [openId, setOpenId] = useState<string | null>(null)
  const [view, setView] = useState<View>('all')
  const [folder, setFolder] = useState('')
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const open = campaigns.campaigns.find(c => c.id === openId)
  const list = campaigns.campaigns
  const count = (v: View) => list.filter(c => (v === 'all' ? c.status !== 'done' : c.status === v)).length
  const folders = [...new Set(list.map(c => c.config.folder).filter((f): f is string => !!f))].sort()
  const shown = list.filter(c => (view === 'all' ? c.status !== 'done' : c.status === view))
    .filter(c => !folder || c.config.folder === folder)
    .filter(c => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()))

  if (campaigns.error) {
    return (
      <section className="card">
        <h2>Campaigns aren't set up yet</h2>
        <p className="small muted">Run <code>supabase/campaigns.sql</code> in the Supabase SQL Editor, then <code>scripts/import_campaign.mjs</code>. ({campaigns.error})</p>
      </section>
    )
  }
  if (!campaigns.loaded) return <p className="muted small">Loading campaigns…</p>
  if (open) return <CampaignView key={open.id} {...props} campaign={open} onBack={() => setOpenId(null)} />

  return (
    <div className="stack">
      <div className="toolbar">
        <Segmented value={view} onChange={setView} options={[
          { id: 'all', label: `All ${count('all')}` }, { id: 'active', label: `Active ${count('active')}` },
          { id: 'paused', label: `Paused ${count('paused')}` }, { id: 'done', label: `Archived ${count('done')}` },
        ]} />
        <input className="input input-sm" placeholder="Search campaigns" value={q} onChange={e => setQ(e.target.value)} aria-label="Search campaigns" />
        {folders.length > 0 && (
          <select className="select select-sm" value={folder} onChange={e => setFolder(e.target.value)} aria-label="Folder">
            <option value="">All folders</option>
            {folders.map(f => <option key={f}>{f}</option>)}
          </select>
        )}
        <span className="toolbar-end"><button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}><Plus size={14} /> Create campaign</button></span>
      </div>
      {creating && <CreateCampaign folders={folders} onCancel={() => setCreating(false)} onCreated={async id => { await campaigns.reload(); setCreating(false); setOpenId(id) }} />}
      <section className="card flush">
        <div className="table-scroll">
          <table className="table camp-table">
            <thead>
              <tr><th>Campaign</th><th>Status</th><th>Progress</th><th className="num">Sent</th><th className="num">Replied</th><th className="num">Follow-ups due</th><th /></tr>
            </thead>
            <tbody>
              {shown.map(c => <CampaignRow key={c.id} c={c} {...props} onOpen={() => setOpenId(c.id)} />)}
              {!shown.length && <tr><td colSpan={7} className="empty">No campaigns here.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

/** The first step of a new campaign: its name, and a folder if you want one. */
function CreateCampaign({ folders, onCancel, onCreated }: { folders: string[]; onCancel: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({})
  const create = async () => {
    setState({ busy: true })
    const r = await api<{ id: string }>({ action: 'create', name, folder }, '/api/campaign')
    if (r.error) return setState({ error: r.error })
    onCreated(r.id)
  }
  return (
    <section className="card">
      <h2>Create campaign</h2>
      <div className="row2">
        <label className="field"><span className="small">Campaign name</span><input className="input" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && create()} autoFocus /></label>
        <label className="field">
          <span className="small">Folder (optional)</span>
          <input className="input" list="campaign-folders" value={folder} onChange={e => setFolder(e.target.value)} />
          <datalist id="campaign-folders">{folders.map(f => <option key={f} value={f} />)}</datalist>
        </label>
      </div>
      <div className="row-wrap">
        <button className="btn btn-primary" onClick={create} disabled={state.busy || !name.trim()}>{state.busy ? 'Creating…' : 'Create and add leads'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
        {state.error && <span className="small error-text">{state.error}</span>}
      </div>
    </section>
  )
}

function CampaignRow({ c, campaigns, tracks, now, onOpen }: ColdProps & { c: Campaign; onOpen: () => void }) {
  const s = useMemo(() => {
    let leads = 0, contacted = 0, sent = 0, replied = 0, due = 0
    for (const m of campaigns.members.values()) {
      if (m.campaignId !== c.id) continue
      leads++
      const t = tracks[m.leadId]
      if (!t?.sentAt) continue
      contacted++
      sent += 1 + t.followUps.length
      if (t.repliedAt) replied++
      if (derive(t, c.cadence, now).status === 'due') due++
    }
    return { leads, contacted, sent, replied, due }
  }, [c, campaigns.members, tracks, now])
  return (
    <tr className="row-link" onClick={onOpen}>
      <td>
        <div className="strong">{c.name}</div>
        <div className="small muted">{c.steps.length} emails · day {c.steps.map(x => x.day).join(', ')}</div>
      </td>
      <td><CampaignStatus c={c} /></td>
      <td>
        <div className="progress">
          <span className="meter"><span style={{ width: `${(100 * s.contacted) / Math.max(1, s.leads)}%` }} /></span>
          <span className="small muted nowrap">{s.contacted.toLocaleString()} / {s.leads.toLocaleString()}</span>
        </div>
      </td>
      <td className="num">{s.sent.toLocaleString()}</td>
      <td className="num">{s.replied} <span className="muted small">{pctText(s.replied, s.contacted)}</span></td>
      <td className="num">{s.due.toLocaleString()}</td>
      <td className="num"><ChevronRight size={16} className="muted" /></td>
    </tr>
  )
}

export function CampaignStatus({ c }: { c: Campaign }) {
  return (
    <span className="row-wrap nowrap">
      <span className={`pill ${c.status === 'active' ? 'pill-good' : 'pill-muted'}`}><i />{c.status === 'active' ? 'Active' : c.status === 'done' ? 'Archived' : 'Paused'}</span>
      {c.followUpsPaused && <span className="pill pill-warn">Follow-ups paused</span>}
    </span>
  )
}
