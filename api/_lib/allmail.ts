// All mail: a live look at each inbox over IMAP, whoever the mail is from. Nothing is copied to the database, and the
// mailbox opens read-only, so reading here never marks anything read in Gmail.
import { simpleParser } from 'mailparser'
import { errorMessage } from './env.js'
import { imapClient } from './mail.js'

export interface MailRow {
  inbox: string; uid: number; from: string; name: string; subject: string; at: string; unread: boolean
  /** The thread in Gmail, where it can be answered. */
  link?: string
}

type Client = Awaited<ReturnType<typeof imapClient>>

async function withInbox<T>(inbox: string, run: (client: Client) => Promise<T>) {
  const client = await imapClient(inbox)
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      return await run(client)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

const gmailLink = (inbox: string, threadId?: string) =>
  threadId && /^\d+$/.test(threadId) ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(inbox)}#all/${BigInt(threadId).toString(16)}` : undefined

async function latest(inbox: string, limit: number, search: string): Promise<MailRow[]> {
  return withInbox(inbox, async client => {
    const exists = client.mailbox ? client.mailbox.exists : 0
    if (!exists) return []
    // Gmail's own search covers the whole inbox, not just what's loaded. With none, the newest mail is simply the last.
    const range = search ? ((await client.search({ gmailraw: search }, { uid: true })) || []).slice(-limit) : `${Math.max(1, exists - limit + 1)}:*`
    if (!range.length) return []
    const found = await client.fetchAll(range, { uid: true, envelope: true, flags: true, internalDate: true, threadId: true }, { uid: !!search })
    return found.map(m => {
      const sender = m.envelope?.from?.[0]
      return {
        inbox, uid: m.uid, from: sender?.address ?? '', name: sender?.name || sender?.address || 'Unknown', subject: m.envelope?.subject || '(no subject)',
        at: new Date(m.internalDate ?? 0).toISOString(), unread: !m.flags?.has('\\Seen'), link: gmailLink(inbox, m.threadId),
      }
    })
  })
}

/** The newest mail across these inboxes. One unreadable inbox is reported, not fatal. */
export async function listMail(inboxes: string[], limit: number, search: string) {
  const results = await Promise.allSettled(inboxes.map(i => latest(i, limit, search)))
  const rows = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
  return {
    rows: rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit),
    failed: inboxes.flatMap((inbox, k) => {
      const r = results[k]
      return r.status === 'rejected' ? [{ inbox, error: errorMessage(r.reason) }] : []
    }),
  }
}

/** One email as plain text: the dashboard never renders mail's own HTML, so trackers and scripts in it stay inert. */
export async function readMail(inbox: string, uid: number) {
  return withInbox(inbox, async client => {
    const m = await client.fetchOne(String(uid), { source: { maxLength: 2_000_000 }, envelope: true }, { uid: true })
    if (!m || !m.source) throw new Error('That email is no longer in the inbox.')
    const parsed = await simpleParser(m.source)
    return {
      to: (m.envelope?.to ?? []).map(a => a.address).filter(Boolean).join(', '),
      body: (parsed.text ?? '').slice(0, 200_000),
      attachments: parsed.attachments.filter(a => !a.related).map(a => a.filename ?? 'attachment'),
    }
  })
}
