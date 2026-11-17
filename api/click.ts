// Click tracking: /api/click?m=<email_messages id>&u=<url>&t=<signature>. Records the click, then goes to the link.
// The signature covers the url, so this can't be used to redirect anyone anywhere else.
import { db } from './_lib/db.js'
import { verifyClick } from './_lib/env.js'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const id = Number(url.searchParams.get('m'))
  const target = url.searchParams.get('u') ?? ''
  const token = url.searchParams.get('t') ?? ''
  if (!Number.isSafeInteger(id) || id <= 0 || !/^https?:\/\//i.test(target) || !verifyClick(id, target, token)) {
    return new Response('This link is not valid.', { status: 400 })
  }
  try {
    await db().rpc('record_email_click', { p_id: id })
  } catch {
    // The reader still gets where they were going.
  }
  return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store' } })
}
