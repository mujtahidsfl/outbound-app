import { useEffect, useRef, useState } from 'react'
import { removeCampaignImage, signCampaignImages, uploadCampaignImage } from '../../../campaigns'
import type { MediaItem } from '../../../types'
import type { CampaignProps } from './CampaignView'

const size = (b = 0) => (b < 1048576 ? `${b ? Math.max(1, Math.round(b / 1024)) : 0} KB` : `${(b / 1048576).toFixed(1)} MB`)

/** Screenshots shared by the campaign's follow-ups. Uploaded once, attached to every email that has "Attach screenshots" on. */
export default function Screenshots({ campaign: c, campaigns }: CampaignProps) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState<string>()
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [dragging, setDragging] = useState(false)
  const total = c.images.reduce((s, i) => s + (i.size ?? 0), 0)
  const attachedTo = c.steps.filter(s => s.attachImages).map(s => `Email ${s.n}`)

  const pathsKey = c.images.flatMap(i => (i.path ? [i.path] : [])).join('\n')
  useEffect(() => {
    let cancelled = false
    signCampaignImages(pathsKey ? pathsKey.split('\n') : []).then(u => !cancelled && setUrls(u)).catch(e => !cancelled && setError(String(e.message ?? e)))
    return () => { cancelled = true }
  }, [pathsKey])

  const upload = async (files: FileList | File[]) => {
    const list = [...files].filter(f => f.type.startsWith('image/'))
    if (!list.length) return setError('Pick image files (PNG or JPG).')
    setError(undefined)
    setBusy(list.length)
    const added: MediaItem[] = []
    for (const f of list) {
      try {
        added.push(await uploadCampaignImage(c.id, f))
      } catch (e) {
        setError(`${f.name} not uploaded: ${e instanceof Error ? e.message : e}`)
      }
      setBusy(n => n - 1)
    }
    if (added.length) setError(await campaigns.update(c.id, { images: [...c.images, ...added] }))
  }

  const remove = async (m: MediaItem) => {
    if (!confirm(`Remove "${m.name}" from the campaign?`)) return
    const err = await campaigns.update(c.id, { images: c.images.filter(i => i.path !== m.path) })
    if (err) return setError(err)
    if (m.path) removeCampaignImage(m.path).catch(() => {})
  }

  const move = (i: number, d: number) => {
    const next = [...c.images]
    const [x] = next.splice(i, 1)
    next.splice(i + d, 0, x)
    campaigns.update(c.id, { images: next })
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Screenshots of past builds</h2>
          <span className="small muted">{c.images.length} file{c.images.length === 1 ? '' : 's'} · {size(total)} · attached to {attachedTo.length ? attachedTo.join(', ') : 'no email yet (turn it on under Emails & A/B)'}</span>
        </div>
        <p className="small muted">
          Upload once here and every lead's {attachedTo.join(' / ') || 'follow-up'} carries the same files, in this order. 2–3 images works best.
          Big images are shrunk automatically: keep the total under about 1.5 MB, since heavy emails land in spam more often.
        </p>
        {total > 1_500_000 && <p className="small due-text">These add up to {size(total)}. Consider removing one or two for better deliverability.</p>}
        <div
          className={dragging ? 'media-grid dragging' : 'media-grid'}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={e => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files) }}
        >
          {c.images.map((m, i) => (
            <figure className="media-item" key={m.path}>
              <a className="media-thumb" href={m.path ? urls[m.path] : undefined} target="_blank" rel="noreferrer" title={`Open ${m.name}`}>
                {m.path && urls[m.path] ? <img src={urls[m.path]} alt={m.name} loading="lazy" /> : <span className="media-ext">IMG</span>}
              </a>
              <figcaption>
                <span className="media-name" title={`${m.name} · ${size(m.size)}`}>{i + 1}. {m.name}</span>
                {i > 0 && <button className="icon-btn" onClick={() => move(i, -1)} aria-label="Move earlier">‹</button>}
                {i < c.images.length - 1 && <button className="icon-btn" onClick={() => move(i, 1)} aria-label="Move later">›</button>}
                <button className="icon-btn" onClick={() => remove(m)} aria-label={`Remove ${m.name}`}>✕</button>
              </figcaption>
            </figure>
          ))}
          <button className="media-add" onClick={() => input.current?.click()} disabled={busy > 0}>
            <span className="media-add-plus" aria-hidden>+</span>
            {busy ? `Uploading ${busy}…` : 'Add screenshots'}
            <span className="muted tiny">or drop them here</span>
          </button>
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={e => { if (e.target.files) upload(e.target.files); e.target.value = '' }} />
        {error && <p className="error-text small">{error}</p>}
      </section>
    </div>
  )
}
