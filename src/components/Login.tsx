import { useState } from 'react'
import { supabase } from '../supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null)

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setMsg({ text: error.message, error: true })
  }

  const reset = async () => {
    if (!email) return setMsg({ text: 'Enter your email first.', error: true })
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
    setMsg(error ? { text: error.message, error: true } : { text: 'Check your inbox for a reset link.' })
  }

  return (
    <div className="login-page">
      <div className="login-top">
        <img src="/logo.png" alt="" />
        <div className="brand-name">Outbound</div>
        <small>Outbound</small>
      </div>
      <form className="card login" onSubmit={signIn}>
        <h2>Sign in</h2>
        <p className="sub">Use the account your admin created for you.</p>
        <label className="field">
          <span className="small">Email</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="small">Password</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={reset}>Forgot password?</button>
        {msg && <p className={msg.error ? 'small error-text' : 'small'}>{msg.text}</p>}
      </form>
    </div>
  )
}

export function SetPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const { error } = await supabase.auth.updateUser({ password })
    if (error) return setMsg(error.message)
    window.history.replaceState(null, '', window.location.pathname)
    onDone()
  }
  return (
    <div className="login-page">
      <form className="card login" onSubmit={save}>
        <h2>Set a new password</h2>
        <label className="field">
          <span className="small">New password</span>
          <input className="input" type="password" minLength={8} autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary btn-block">Save password</button>
        {msg && <p className="small error-text">{msg}</p>}
      </form>
    </div>
  )
}
