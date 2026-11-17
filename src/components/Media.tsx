import { useEffect, useRef, useState, type RefObject } from 'react'
import type { MediaItem, Track } from '../types'
import { actions, type Updater } from '../tracking'
import { removeMedia, signMedia, uploadMedia } from '../supabase'

export function MediaSelect({ done, onChange }: { done: boolean; onChange: (done: boolean) => void }) {
  return (
    <select
      className={done ? 'select select-sm media-done' : 'select select-sm'}
      value={done ? 'done' : ''}
      onChange={e => onChange(e.target.value === 'done')}
      aria-label="Media status"
    >
      <option value="">Not done</option>
      <option value="done">✓ Done</option>
    </select>
  )
}

function useUploader(leadId: string, update: Updater) {
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const upload = (files: FileList) => {
    // Copy first: the caller resets the file input right after, which empties the live FileList.
    const list = [...files]
    if (!list.length) return
    setError(null)
    setBusy(n => n + list.length)
    for (const f of list) {
      uploadMedia(leadId, f)
        .then(item => update(leadId, actions.addMedia(item)))
        .catch(e => setError(`${f.name} not uploaded: ${e.message ?? e}`))
        .finally(() => setBusy(n => n - 1))
    }
  }
  return { busy, error, setError, upload }
}

function FileInput({ inputRef, onFiles }: { inputRef: RefObject<HTMLInputElement | null>; onFiles: (f: FileList) => void }) {
  return (
    <input ref={inputRef} type="file" multiple hidden onChange={e => { if (e.target.files) onFiles(e.target.files); e.target.value = '' }} />
  )
}

/** Compact version for a table row: status dropdown, then an attach button once media is done. */
export function MediaCell({ leadId, track, update, onOpen }: {
  leadId: string
  track?: Track
  update: Updater
  onOpen: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const { busy, error, upload } = useUploader(leadId, update)
  const count = track?.media?.length ?? 0
  return (
    <span className="media-cell">
      <MediaSelect done={!!track?.mediaDone} onChange={v => update(leadId, actions.setMediaDone(v))} />
      {track?.mediaDone && (
        <>
          <button className="btn btn-sm" onClick={() => input.current?.click()} disabled={busy > 0}>
            {busy ? 'Uploading…' : '+ Attach'}
          </button>
          {count > 0 && <button className="link small" onClick={onOpen}>{count} attached</button>}
          <FileInput inputRef={input} onFiles={upload} />
        </>
      )}
      {error && <span className="error-text tiny" title={error}>Upload failed</span>}
    </span>
  )
}

/** Full version for the lead drawer: thumbnails, upload or drop files, paste links. */
export function MediaPanel({ leadId, media = [], update }: { leadId: string; media?: MediaItem[]; update: Updater }) {
  const input = useRef<HTMLInputElement>(null)
  const { busy, error, setError, upload } = useUploader(leadId, update)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [link, setLink] = useState('')
  const [dragging, setDragging] = useState(false)

  const pathsKey = media.flatMap(m => (m.path ? [m.path] : [])).join('\n')
  useEffect(() => {
    let cancelled = false
    signMedia(pathsKey ? pathsKey.split('\n') : [])
      .then(u => !cancelled && setUrls(u))
      .catch(e => !cancelled && setError(`Could not load attachments: ${e.message ?? e}`))
    return () => { cancelled = true }
  }, [pathsKey, setError])

  const addLink = () => {
    const raw = link.trim()
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    try {
      new URL(href)
    } catch {
      setError("That doesn't look like a link.")
      return
    }
    update(leadId, actions.addMedia({ name: href.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''), url: href }))
    setLink('')
    setError(null)
  }

  const remove = (m: MediaItem) => {
    if (!confirm(`Remove "${m.name}"?`)) return
    update(leadId, actions.removeMedia(m))
    // The lead no longer points at the file, so a failed storage delete only leaves a harmless orphan.
    if (m.path) removeMedia(m.path).catch(() => {})
  }

  return (
    <div className="media-panel">
      <div
        className={dragging ? 'media-grid dragging' : 'media-grid'}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={e => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files) }}
      >
        {media.map(m => {
          const href = m.path ? urls[m.path] : m.url
          return (
            <figure className="media-item" key={m.path ?? m.url}>
              <a className="media-thumb" href={href} target="_blank" rel="noreferrer" title={`Open ${m.name}`}>
                {href && m.type?.startsWith('image/') ? <img src={href} alt={m.name} loading="lazy" />
                  : href && m.type?.startsWith('video/') ? <video src={href} preload="metadata" muted />
                  : <span className="media-ext">{m.url ? 'Link' : extension(m.name)}</span>}
              </a>
              <figcaption>
                <span className="media-name" title={m.size ? `${m.name} · ${formatSize(m.size)}` : m.name}>{m.name}</span>
                <button className="icon-btn" onClick={() => remove(m)} aria-label={`Remove ${m.name}`}>✕</button>
              </figcaption>
            </figure>
          )
        })}
        <button className="media-add" onClick={() => input.current?.click()} disabled={busy > 0}>
          <span className="media-add-plus" aria-hidden>+</span>
          {busy ? `Uploading ${busy}…` : 'Add files'}
          <span className="muted tiny">or drop them here</span>
        </button>
      </div>
      <FileInput inputRef={input} onFiles={upload} />
      <div className="row-wrap">
        <input
          className="input input-sm media-link"
          placeholder="…or paste a link (Loom, Drive, Figma)"
          value={link}
          onChange={e => setLink(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && link.trim() && addLink()}
        />
        <button className="btn btn-sm" onClick={addLink} disabled={!link.trim()}>Add link</button>
      </div>
      {error && <p className="error-text small">{error}</p>}
    </div>
  )
}

function extension(name: string) {
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  return ext ? ext.slice(0, 4).toUpperCase() : 'File'
}

function formatSize(bytes: number) {
  return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`
}
