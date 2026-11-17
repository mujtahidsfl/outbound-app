// Emails to you (the alert address in Settings): a positive reply, the moment it lands, and the end-of-day digest.
import { randomUUID } from 'node:crypto'
import type { Settings } from '../../src/types.ts'
import { loginInboxes } from './google.js'
import { publicUrl } from './env.js'
import { buildRaw, smtpSend } from './mail.js'

/** The master inbox, opened on one lead's conversation. */
export const threadUrl = (leadId: string) => `${publicUrl()}/?lead=${encodeURIComponent(leadId)}`

/** Send from the first inbox that can log in. False when no alert address is set. */
export async function notifyMe(settings: Settings, subject: string, text: string) {
  const to = settings.alertEmail?.trim()
  if (!to) return false
  const ready = await loginInboxes(settings.inboxes)
  const from = settings.inboxes.find(i => ready.has(i))
  if (!from) throw new Error('no connected inbox to send from')
  await smtpSend(from, to, await buildRaw({ from, fromName: 'Outbound', to, subject, text, messageId: `<${randomUUID()}@${from.split('@')[1]}>` }))
  return true
}
