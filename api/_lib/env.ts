// Server configuration. Secrets live in Vercel environment variables, never in the browser bundle.
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Mail servers: GoDaddy "Professional Email powered by Titan" unless SMTP_HOST/IMAP_HOST say otherwise (e.g. smtp.gmail.com). */
export const SMTP_HOST = process.env.SMTP_HOST || 'smtpout.secureserver.net'
export const IMAP_HOST = process.env.IMAP_HOST || 'imap.secureserver.net'

/** @gmail.com / @googlemail.com addresses always go through Google, whatever the hosts above are. */
export const isPersonalGmail = (inbox: string) => /@(gmail|googlemail)\.com$/i.test(inbox.trim())
/** Gmail and Google Workspace inboxes. Google files SMTP sends in Sent itself, so the app mustn't append a second copy. */
export const isGoogleInbox = (inbox: string) => isPersonalGmail(inbox) || /\.gmail\.com$|\.google\.com$/i.test(SMTP_HOST)
export const smtpHost = (inbox: string) => (isPersonalGmail(inbox) ? 'smtp.gmail.com' : SMTP_HOST)
export const imapHost = (inbox: string) => (isPersonalGmail(inbox) ? 'imap.gmail.com' : IMAP_HOST)

/**
 * Inbox passwords: INBOX_PASSWORD is shared by every inbox; a per-inbox var overrides it for that inbox,
 * e.g. alex@yourdomain.com → INBOX_PASSWORD_ALEX_YOURDOMAIN_COM.
 */
export const passwordVar = (inbox: string) => `INBOX_PASSWORD_${inbox.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
export const inboxPassword = (inbox: string) => process.env[passwordVar(inbox)] || process.env.INBOX_PASSWORD || ''

export function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing ${name} environment variable`)
  return v
}

/** Base URL for links in emails (unsubscribe, open pixel). */
export function publicUrl(): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '')
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  return 'http://localhost:5173'
}

// ---------- signed unsubscribe links ----------

const sign = (leadId: string) =>
  createHmac('sha256', requireEnv('UNSUBSCRIBE_SECRET')).update(leadId).digest('base64url').slice(0, 24)

export const unsubscribeUrl = (leadId: string) =>
  `${publicUrl()}/api/unsubscribe?l=${encodeURIComponent(leadId)}&t=${sign(leadId)}`

export function verifyUnsubscribe(leadId: string, token: string): boolean {
  return same(sign(leadId), token)
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// ---------- signed open-tracking pixel ----------

const signOpen = (messageId: number) => sign(`open:${messageId}`).slice(0, 16)

export const openPixelUrl = (messageId: number) => `${publicUrl()}/api/open?m=${messageId}&t=${signOpen(messageId)}`

/** Open tracking is off (user's call, 2026-11-09): no email carries the pixel and none is logged as tracked. Set true to turn it back on. */
export const TRACK_OPENS = false

/** The pixel for one email, or nothing while open tracking is off. */
export const pixelFor = (messageId: number) => (TRACK_OPENS ? openPixelUrl(messageId) : undefined)

export const verifyOpen = (messageId: number, token: string) => same(signOpen(messageId), token)

// ---------- signed click tracking ----------

const signClick = (messageId: number, url: string) => sign(`click:${messageId}:${url}`).slice(0, 16)

export const clickUrl = (messageId: number, url: string) =>
  `${publicUrl()}/api/click?m=${messageId}&u=${encodeURIComponent(url)}&t=${signClick(messageId, url)}`

export const verifyClick = (messageId: number, url: string, token: string) => same(signClick(messageId, url), token)

// ---------- signed Google sign-in state ----------

/** Good for 10 minutes, the time to pick an account on Google's screen. */
export function googleState() {
  const expires = String(Date.now() + 10 * 60_000)
  return `${expires}.${sign(`google:${expires}`)}`
}

export function verifyGoogleState(state: string) {
  const [expires = '', token = ''] = state.split('.')
  return Number(expires) > Date.now() && same(sign(`google:${expires}`), token)
}

// ---------- responses ----------

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
