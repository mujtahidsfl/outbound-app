// Where Google sends the browser back after "Add inbox". Stores the login, proves it works, then adds the inbox to sending.
// No dashboard session here: the signed state (only signed-in users can get one) is what makes the callback trusted.
import { loadSettings, patchSettings } from './_lib/db.js'
import { errorMessage, publicUrl, verifyGoogleState } from './_lib/env.js'
import { deleteGoogleLogin, exchangeCode, saveGoogleLogin } from './_lib/google.js'
import { checkInbox } from './_lib/mail.js'

// The result rides in the URL fragment, which never reaches a server or its logs.
const back = (result: Record<string, string>) =>
  new Response(null, { status: 302, headers: { location: `${publicUrl()}/#${new URLSearchParams(result)}`, 'cache-control': 'no-store' } })
const failed = (message: string) => back({ google: 'error', message })

export async function GET(request: Request) {
  const url = new URL(request.url)
  if (!verifyGoogleState(url.searchParams.get('state') ?? '')) return failed('That sign-in took too long. Click Add inbox again.')
  const code = url.searchParams.get('code')
  if (!code) return failed('Google sign-in was cancelled.')

  try {
    const { inbox, refreshToken, accessToken, expiresIn } = await exchangeCode(code)
    await saveGoogleLogin(inbox, refreshToken, accessToken, expiresIn)
    const check = await checkInbox(inbox)
    if (check.smtp !== 'ok' || check.imap !== 'ok') {
      await deleteGoogleLogin(inbox)
      return failed(`${inbox} signed in, but ${check.smtp !== 'ok' ? `sending failed: ${check.smtp}` : `reading mail failed: ${check.imap}`}`)
    }
    // A new inbox starts on the warm-up ramp. Signing in to an existing one just swaps its password for Google.
    const settings = await loadSettings()
    if (!settings.inboxes.includes(inbox)) {
      await patchSettings({
        inboxes: [...settings.inboxes, inbox],
        warmupInboxes: [...settings.warmupInboxes.filter(i => i !== inbox), inbox],
        retiredInboxes: settings.retiredInboxes?.filter(i => i !== inbox),
      })
      return back({ google: 'added', inbox })
    }
    return back({ google: 'updated', inbox })
  } catch (e) {
    return failed(errorMessage(e))
  }
}
