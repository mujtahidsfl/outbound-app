// Sorting incoming mail into replies, opt-outs, out-of-office auto-replies and bounces. Pure functions, no I/O.

export type InboundKind = 'reply' | 'unsubscribe' | 'auto' | 'bounce'

export interface Inbound {
  from: string
  subject: string
  text: string
  headers: Record<string, string> // lowercased names
}

const BOUNCE_SENDERS = /^(mailer-daemon|postmaster|mail-daemon|maildaemon)@/i
const BOUNCE_SUBJECT = /delivery status notification|undeliver|mail delivery (failed|subsystem)|delivery has failed|failure notice|returned mail|delivery incomplete|could not be delivered|message not delivered/i
const AUTO_SUBJECT = /^(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|ooo\b|away from (the )?office|on vacation|thank you for (your email|contacting))/i
const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not (contact|email)|don'?t (contact|email))\b/i

/** The new text of a reply, without the quoted thread below it. */
export function newText(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*>/.test(line)) break
    if (/^\s*On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^\s*From:\s.+/i.test(line)) break
    out.push(line)
  }
  return out.join('\n').trim()
}

export function classify(m: Inbound): InboundKind {
  if (BOUNCE_SENDERS.test(m.from) || BOUNCE_SUBJECT.test(m.subject) || m.headers['x-failed-recipients']) return 'bounce'
  const auto = (m.headers['auto-submitted'] ?? 'no').toLowerCase()
  if (auto !== 'no' || m.headers['x-autoreply'] || m.headers['x-autorespond'] || AUTO_SUBJECT.test(m.subject)) return 'auto'
  if (OPT_OUT.test(m.subject) || OPT_OUT.test(newText(m.text).slice(0, 500))) return 'unsubscribe'
  return 'reply'
}

/** Message-IDs a message points back to: In-Reply-To, References, and (for bounces) any quoted in the body. */
export function referencedIds(m: Inbound, ourDomains: string[]): string[] {
  const ids = new Set<string>()
  for (const h of ['in-reply-to', 'references']) for (const id of (m.headers[h] ?? '').match(/<[^<>\s]+>/g) ?? []) ids.add(id)
  if (ourDomains.length) {
    const domains = ourDomains.map(d => d.replace(/\./g, '\\.')).join('|')
    for (const id of m.text.match(new RegExp(`<[^<>\\s]+@(?:${domains})>`, 'gi')) ?? []) ids.add(id)
  }
  return [...ids]
}

/** Parse "Name: value" header lines (as returned by IMAP) into a lowercased map, unfolding continuations. */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.replace(/\r\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

import type { ReplyIntent } from '../../src/types.ts'

const JUST_NO = /^(please )?(no|nope|nah|não|nao|non|no thanks?|no thank you|no gracias|não obrigad[oa]|not interested|pass|stop|remove|unsubscribe)[\s.!,]*(thanks?|thank you|gracias|obrigad[oa]|merci)?[\s.!]*$/
const NOT_INTERESTED = /\b(not interested|not a fit|no thanks|no thank you|we'?re (good|all set|covered)|all set|already have (a|someone|one)|please remove|not at this time|not right now)\b/
const LOOM = /\bloom\b|\bvideos?\b|\bsend (it|it over|the video|me the video|over the video|the 90)\b|\bvideo (please|sounds good)\b/
const MEETING = /\b(let'?s (talk|chat)|call me|give me a call|my (cell|number)|schedule|book|available|what time|when can)\b/
const INTERESTED = /\b(yes|yeah|yep|yup|sure|interested|sounds (good|great|interesting)|let'?s do it|how much|pricing|price|cost|tell me more|more info)\b/

/** What a human reply is asking for. The emails invite "Loom" (send the video) or "no" (stop emailing). */
export function classifyIntent(text: string): ReplyIntent {
  const t = newText(text).toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 800)
  if (!t) return 'other'
  if (JUST_NO.test(t)) return 'not_interested'
  if (LOOM.test(t)) return 'loom'
  if (NOT_INTERESTED.test(t)) return 'not_interested'
  if (MEETING.test(t)) return 'meeting'
  if (INTERESTED.test(t)) return 'interested'
  if (t.includes('?')) return 'question'
  return 'other'
}
