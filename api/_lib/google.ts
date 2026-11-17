// Google sign-in for inboxes: "Add inbox" sends you to Google, api/google.ts stores what comes back, and SMTP/IMAP
// then log in with a short-lived access token instead of an app password. Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { db } from './db.js'
import { inboxPassword, publicUrl, requireEnv } from './env.js'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
// IMAP and SMTP over OAuth only accept Google's full mail scope.
const MAIL_SCOPE = 'https://mail.google.com/'
const redirectUri = () => `${publicUrl()}/api/google`

/** Where "Add inbox" goes. Asks which account every time, and for offline access so sending works with you logged out. */
export function googleSignInUrl(state: string) {
  const params = new URLSearchParams({
    client_id: requireEnv('GOOGLE_CLIENT_ID'),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: `openid email ${MAIL_SCOPE}`,
    access_type: 'offline',
    prompt: 'select_account consent',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

type TokenReply = { access_token?: string; refresh_token?: string; id_token?: string; scope?: string; expires_in?: number; error?: string; error_description?: string }

async function tokenRequest(fields: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: requireEnv('GOOGLE_CLIENT_ID'), client_secret: requireEnv('GOOGLE_CLIENT_SECRET'), ...fields }),
    signal: AbortSignal.timeout(15_000),
  })
  return (await res.json().catch(() => ({ error: `Google answered ${res.status}` }))) as TokenReply
}

/** Trade the code Google handed back for this account's address and tokens. */
export async function exchangeCode(code: string) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() })
  if (!t.access_token || !t.id_token) throw new Error(t.error_description || t.error || 'Google did not return a sign-in')
  // Google can let you untick permissions on its consent screen. Without mail access the inbox can't send.
  if (!t.scope?.split(' ').includes(MAIL_SCOPE)) throw new Error('Tick the Gmail permission on the Google screen, then try again.')
  if (!t.refresh_token) throw new Error('Google did not grant offline access. Try again.')
  // id_token came straight from Google over TLS, so its signature doesn't need checking.
  const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()) as { email?: string; email_verified?: boolean }
  if (!claims.email || !claims.email_verified) throw new Error('Google did not confirm this account\'s address.')
  return { inbox: claims.email.toLowerCase(), refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in ?? 3600 }
}

// ---------- stored logins ----------

// Refresh tokens open the whole mailbox, so the database only ever holds them encrypted.
const key = () => createHash('sha256').update(`inbox-google:${requireEnv('UNSUBSCRIBE_SECRET')}`).digest()

function encrypt(text: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.')
}

function decrypt(stored: string) {
  const [iv, tag, data] = stored.split('.').map(p => Buffer.from(p, 'base64url'))
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

const accessTokens = new Map<string, { token: string; expires: number }>()

export async function saveGoogleLogin(inbox: string, refreshToken: string, accessToken: string, expiresIn: number) {
  const { error } = await db().from('inbox_google').upsert({
    inbox, refresh_token: encrypt(refreshToken), connected_at: new Date().toISOString(),
  })
  if (error) throw new Error(error.message)
  accessTokens.set(inbox, { token: accessToken, expires: Date.now() + (expiresIn - 300) * 1000 })
}

export async function deleteGoogleLogin(inbox: string) {
  accessTokens.delete(inbox)
  await db().from('inbox_google').delete().eq('inbox', inbox)
}

/** A live access token for an inbox connected with Google, or null for one that uses a password (or before google.sql runs). */
export async function googleAccessToken(inbox: string): Promise<string | null> {
  const cached = accessTokens.get(inbox)
  if (cached && cached.expires > Date.now()) return cached.token
  const { data } = await db().from('inbox_google').select('refresh_token').eq('inbox', inbox).maybeSingle()
  if (!data) return null
  const t = await tokenRequest({ refresh_token: decrypt(data.refresh_token as string), grant_type: 'refresh_token' })
  if (!t.access_token) {
    throw new Error(t.error === 'invalid_grant'
      ? `Google signed ${inbox} out (password changed or access removed). Click Add inbox and sign in to it again.`
      : `Google refused ${inbox}: ${t.error_description || t.error || 'no access token'}`)
  }
  accessTokens.set(inbox, { token: t.access_token, expires: Date.now() + ((t.expires_in ?? 3600) - 300) * 1000 })
  return t.access_token
}

/** The inboxes in `inboxes` that can log in: connected with Google, or with an app password in Vercel. */
export async function loginInboxes(inboxes: string[]) {
  const { data } = await db().from('inbox_google').select('inbox').in('inbox', inboxes)
  const google = new Set((data ?? []).map(r => r.inbox as string))
  return new Set(inboxes.filter(i => google.has(i) || inboxPassword(i)))
}
