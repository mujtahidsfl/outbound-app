// The HTML signature on outgoing email. Text only, with no links, on purpose: in Gmail placement tests banner and linked
// signatures went to Promotions. Signers are set in SIGNERS (src/core.ts); a sender with no entry keeps the plain
// text sign-off.
import { SIGNERS as PEOPLE, inboxPersona } from '../../src/core.js'

export const hasSignature = (inbox: string) => !!PEOPLE[inboxPersona(inbox)]

/** The block itself. `address` is the postal line, kept visible under the title because every email needs it. */
export function signatureHtml(inbox: string, address?: string) {
  const person = PEOPLE[inboxPersona(inbox)]
  if (!person) return ''
  const lines = [`<b>${person.name}</b>`, person.title, address?.replace(/^[^·\n]+ · /, '')]
  return `<div style="margin-top:14px">${lines.filter(Boolean).join('<br>\n')}</div>`
}
