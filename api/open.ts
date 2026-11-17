// Open-tracking pixel: /api/open?m=<email_messages id>&t=<signature>. Always answers with a 1×1 transparent GIF.
import { db } from './_lib/db.js'
import { verifyOpen } from './_lib/env.js'

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

async function handle(request: Request) {
  const url = new URL(request.url)
  const id = Number(url.searchParams.get('m'))
  const token = url.searchParams.get('t') ?? ''
  try {
    if (Number.isSafeInteger(id) && id > 0 && verifyOpen(id, token)) await db().rpc('record_email_open', { p_id: id })
  } catch {
    // Never let a tracking hiccup show a broken image.
  }
  return new Response(GIF, {
    headers: { 'content-type': 'image/gif', 'content-length': String(GIF.length), 'cache-control': 'no-store, no-cache, must-revalidate, private' },
  })
}

export const GET = handle
