import { supabase } from './supabase'

export type ApiResult<T = object> = T & { ok?: boolean; error?: string; warning?: string }

/** Call the server (api/send.ts unless told otherwise) as the signed-in user. Errors come back as `{ error }`, never thrown. */
export async function api<T = object>(body: Record<string, unknown>, path = '/api/send'): Promise<ApiResult<T>> {
  try {
    const { data } = await supabase.auth.getSession()
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token ?? ''}` },
      body: JSON.stringify(body),
    })
    const out = (await res.json().catch(() => ({}))) as ApiResult<T>
    if (!res.ok && !out.error) out.error = `Server error (${res.status})`
    return out
  } catch (e) {
    return { error: `Couldn't reach the server: ${e instanceof Error ? e.message : e}` } as ApiResult<T>
  }
}
