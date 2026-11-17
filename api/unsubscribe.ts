// One-click unsubscribe from the link in the List-Unsubscribe header (GET from a browser, POST per RFC 8058).
import { today } from '../src/core.js'
import { db, loadTrack, updateTrack } from './_lib/db.js'
import { verifyUnsubscribe } from './_lib/env.js'

const page = (message: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;color:#222;background:#f6f6f3">
<p style="max-width:420px;text-align:center;font-size:16px;line-height:1.5">${message}</p></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )

async function handle(request: Request) {
  const url = new URL(request.url)
  const leadId = url.searchParams.get('l') ?? ''
  const token = url.searchParams.get('t') ?? ''
  try {
    if (!leadId || !token || !verifyUnsubscribe(leadId, token)) return page('This unsubscribe link is not valid.', 400)
    if (await loadTrack(leadId)) {
      await updateTrack(leadId, t => ({ ...t, badReason: t.badReason ?? 'Unsubscribed' }))
      await db().from('email_events').upsert(
        { lead_id: leadId, inbox: '', kind: 'unsubscribe', from_email: leadId, subject: 'Unsubscribe link', message_id: `link:${leadId}`, received_at: new Date().toISOString(), snippet: `Unsubscribed ${today()}` },
        { onConflict: 'inbox,message_id', ignoreDuplicates: true },
      )
    }
    return page("You're unsubscribed. You won't get any more emails from us.")
  } catch {
    return page('Something went wrong. Reply "unsubscribe" to the email instead and we\'ll remove you.', 500)
  }
}

export const GET = handle
export const POST = handle
