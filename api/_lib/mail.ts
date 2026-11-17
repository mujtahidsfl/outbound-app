// SMTP sending and IMAP access for the inboxes (GoDaddy Titan, Gmail or Google Workspace).
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { TIME_ZONE, inboxPersona } from '../../src/core.js'
import { errorMessage, imapHost, inboxPassword, isGoogleInbox, passwordVar, smtpHost, unsubscribeUrl } from './env.js'
import { googleAccessToken, loginInboxes } from './google.js'
import { hasSignature, signatureHtml } from './signature.js'

export interface OutgoingEmail {
  from: string
  fromName: string
  to: string
  subject: string
  text: string
  /** Optional HTML version (the open pixel lives here). */
  html?: string
  messageId: string
  inReplyTo?: string
  references?: string[]
  unsubscribeUrl?: string
  attachments?: { filename: string; content: Buffer; contentType?: string }[]
}

// Builds the exact bytes once, so the same message is sent and saved to the Sent folder.
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })

export async function buildRaw(m: OutgoingEmail): Promise<Buffer> {
  const headers: Record<string, string> = {}
  if (m.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<mailto:${m.from}?subject=unsubscribe>, <${m.unsubscribeUrl}>`
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  }
  const info = await composer.sendMail({
    from: { name: m.fromName, address: m.from },
    to: m.to,
    subject: m.subject,
    text: m.text,
    html: m.html,
    messageId: m.messageId,
    inReplyTo: m.inReplyTo,
    references: m.references,
    attachments: m.attachments,
    headers,
  })
  return info.message as Buffer
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const LINK = /https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g

/** Swap every link in the text for its tracked version. */
export const trackLinks = (text: string, track: (url: string) => string) => text.replace(LINK, track)

/** Plain text as HTML that looks the same, with live links. */
function textHtml(text: string) {
  const links = text.replace(LINK, url => `\0${url}\0`)
  const body = escapeHtml(links).replace(/\0([^\0]+)\0/g, (_, url: string) => `<a href="${url}">${url.length > 60 ? `${url.slice(0, 57)}...` : url}</a>`)
  return `<div>${body.replace(/\r?\n/g, '<br>\n')}</div>`
}

// The written sign-off: first name, then the company and postal line, or just the name closing a hand-written email.
const signOff = (name: string) => new RegExp(`(?:^|\\n)(?:${name}\\n+)?([^·\\n]+ · [^\\n]+)|(?:^|\\n)${name}\\s*$`, 'gi')

/** The signature closes the email: it replaces the sign-off, and anything written after that (a P.S.) moves above it. */
function signedHtml(text: string, inbox: string) {
  const end = [...text.matchAll(signOff(inboxPersona(inbox)))].pop()
  if (!end) return `${textHtml(text.trimEnd())}\n${signatureHtml(inbox)}`
  const above = text.slice(0, end.index).trimEnd()
  const below = text.slice(end.index + end[0].length).trim()
  const written = [above, below].filter(Boolean).join('\n\n')
  return `${written ? `${textHtml(written)}\n` : ''}${signatureHtml(inbox, end[1] && escapeHtml(end[1]))}`
}

/** An earlier email quoted under a follow-up, the way a mail app quotes the message being replied to. */
export type Quote = { header: string; text: string }

const quoteDate = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const quoteTime = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' })

/** "On Mon, Nov 2, 2026 at 10:14 AM Alex <alex@example.com> wrote:", or without the time when only the day is known. */
export function quoteHeader(sent: Date, inbox: string, withTime = true) {
  const when = withTime ? `${quoteDate.format(sent)} at ${quoteTime.format(sent)}` : quoteDate.format(sent)
  return `On ${when.replace(/ /g, ' ')}${withTime ? '' : ','} ${inboxPersona(inbox)} <${inbox}> wrote:`
}

/** The quote as plain text: the header, then every line behind "> ". */
export const quoteText = (q: Quote) => `${q.header}\n\n${q.text.trimEnd().split(/\r?\n/).map(l => (l ? `> ${l}` : '>')).join('\n')}`

// Gmail's own reply markup, so mail apps show and fold it like any other quoted reply.
const quoteHtml = (q: Quote) =>
  `\n<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(q.header)}<br></div>` +
  `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${textHtml(q.text.trimEnd())}</blockquote></div>`

/** The words of an unsubscribe line and the one-click page they link to. */
export type Unsubscribe = { text: string; url: string }

/** Every email to a lead ends with this: "Unsubscribe" (or the campaign's own words) linked to `id`'s one-click page. */
export const unsubscribeLine = (id: string, words?: string): Unsubscribe => ({ text: words?.trim() || 'Unsubscribe', url: unsubscribeUrl(id) })

/** The same line for the plain text part, which can't hyperlink, so the address shows. */
export const unsubscribeText = (u: Unsubscribe) => `${u.text}: ${u.url}`

/** The email as bare HTML, with live links, the sender's signature, and any open pixel, unsubscribe link and quoted email. `plain` leaves the signature out. */
export function emailHtml(text: string, o: { inbox?: string; plain?: boolean; pixelUrl?: string; unsubscribe?: Unsubscribe; quote?: Quote }) {
  const body = !o.plain && o.inbox && hasSignature(o.inbox) ? signedHtml(text, o.inbox) : textHtml(text)
  // Quiet grey, a little smaller than the body text, but big enough to read and tap: an unsubscribe link has to stay findable.
  const unsub = o.unsubscribe ? `\n<p style="margin:12px 0 0;font-size:12px;line-height:1.4"><a href="${escapeHtml(o.unsubscribe.url)}" style="color:#a3a3a3;text-decoration:none">${escapeHtml(o.unsubscribe.text)}</a></p>` : ''
  const quote = o.quote ? quoteHtml(o.quote) : ''
  const pixel = o.pixelUrl ? `\n<img src="${escapeHtml(o.pixelUrl)}" width="1" height="1" alt="" style="border:0;width:1px;height:1px">` : ''
  return `${body}${unsub}${quote}${pixel}`
}

/** How an inbox logs in: its Google sign-in if it has one, else its app password. */
async function login(inbox: string) {
  const accessToken = await googleAccessToken(inbox)
  if (accessToken) return { accessToken }
  const pass = inboxPassword(inbox)
  if (!pass) throw new Error(`No login for ${inbox}. Click Add inbox in Mailboxes, or add ${passwordVar(inbox)} in Vercel.`)
  return { pass }
}

async function smtp(inbox: string) {
  const auth = await login(inbox)
  return nodemailer.createTransport({
    host: smtpHost(inbox),
    port: 465,
    secure: true,
    auth: auth.accessToken ? { type: 'OAuth2', user: inbox, accessToken: auth.accessToken } : { user: inbox, pass: auth.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
}

export async function smtpSend(inbox: string, to: string, raw: Buffer) {
  const transport = await smtp(inbox)
  try {
    await transport.sendMail({ envelope: { from: inbox, to: [to] }, raw })
  } finally {
    transport.close()
  }
}

export async function imapClient(inbox: string) {
  return new ImapFlow({
    host: imapHost(inbox),
    port: 993,
    secure: true,
    auth: { user: inbox, ...(await login(inbox)) },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  })
}

/** Save a sent message to the inbox's Sent folder so the thread shows in Titan webmail. Gmail already does this itself. */
export async function appendToSent(inbox: string, raw: Buffer) {
  if (isGoogleInbox(inbox)) return
  const client = await imapClient(inbox)
  await client.connect()
  try {
    const folders = await client.list()
    const sent = folders.find(f => f.specialUse === '\\Sent')
      ?? folders.find(f => /^(inbox[./])?sent( items| messages)?$/i.test(f.path))
    await client.append(sent?.path ?? 'Sent', raw, ['\\Seen'])
  } finally {
    await client.logout().catch(() => {})
  }
}

export interface InboxCheck {
  inbox: string
  passwordSet: boolean
  smtp: string // 'ok' or the error
  imap: string
}

/** Log in to both servers without sending anything. */
export async function checkInbox(inbox: string): Promise<InboxCheck> {
  const out: InboxCheck = { inbox, passwordSet: (await loginInboxes([inbox])).has(inbox), smtp: 'not checked', imap: 'not checked' }
  if (!out.passwordSet) {
    out.smtp = out.imap = `Click Add inbox, or add ${passwordVar(inbox)} in Vercel`
    return out
  }
  const [s, i] = await Promise.allSettled([
    (async () => {
      const t = await smtp(inbox)
      try { await t.verify() } finally { t.close() }
    })(),
    (async () => {
      const c = await imapClient(inbox)
      await c.connect()
      await c.logout()
    })(),
  ])
  out.smtp = s.status === 'fulfilled' ? 'ok' : errorMessage(s.reason)
  out.imap = i.status === 'fulfilled' ? 'ok' : errorMessage(i.reason)
  return out
}
