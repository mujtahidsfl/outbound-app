// DNS checks for a sending domain: SPF, DKIM, DMARC, MX. Mirrors the AromaLisa engine's scoring.
import { resolveMx, resolveTxt } from 'node:dns/promises'

// GoDaddy Professional Email signs with secureserver1/secureserver2; the rest cover other providers (plus any the user names).
const DKIM_SELECTORS = ['secureserver1', 'secureserver2', 'default', 'titan1', 'titan', 's1', 's2', 'k1', 'k2', 'selector1', 'selector2', 'dkim', 'mail', 'google']

// SPF hosts that cover the inboxes. GoDaddy's DNS templates wrap them in a dc-*._spfm include, so includes are followed.
const SENDING_SPF = new Set(['secureserver.net', '_spf.google.com'])
// Mail servers give up on SPF after 10 lookups, so a match any deeper wouldn't count for them either.
const SPF_MAX_LOOKUPS = 10

export interface DomainCheck {
  domain: string
  score: number
  mode: 'green' | 'yellow' | 'red'
  label: string
  /** Suggested per-inbox daily limit while the setup is incomplete; null = normal paced sending. */
  cap: number | null
  mx: string[]
  spf: string | null
  /** SPF authorises the servers the inboxes send through, directly or via includes: GoDaddy (secureserver.net) or Google (_spf.google.com). Null when a lookup failed. */
  spfCoversSending: boolean | null
  dkimSelector: string | null
  dmarc: string | null
  dmarcPolicy: string | null
  /** Parts whose DNS lookup failed ('SPF' | 'DKIM' | 'DMARC' | 'MX'). They're unknown, not missing, so they don't cost score. */
  unchecked: string[]
  issues: string[]
}

// Only these codes mean the record isn't there. A timeout or SERVFAIL says nothing about it.
const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA'])

/** Runs a DNS lookup, retrying once. Returns `empty` when the record doesn't exist and null when the lookup itself failed. */
async function lookup<T>(run: () => Promise<T>, empty: T): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await run()
    } catch (e) {
      if (NOT_FOUND.has((e as NodeJS.ErrnoException).code ?? '')) return empty
    }
  }
  return null
}

const txt = (name: string) => lookup(async () => (await resolveTxt(name)).map(parts => parts.join('')), [] as string[])

const spfRecord = (records: string[]) => records.find(r => /^v=spf1/i.test(r)) ?? null

/** Walks include: and redirect= terms. A "-include" or "~include" isn't an allow, so only plain or "+" terms count. Null if a lookup failed before a match. */
async function spfCovers(record: string, seen = new Set<string>()): Promise<boolean | null> {
  const hosts = record.split(/\s+/).flatMap(term => /^\+?(?:include:|redirect=)(.+)$/i.exec(term)?.[1]?.toLowerCase() ?? [])
  if (hosts.some(h => SENDING_SPF.has(h))) return true
  let failed = false
  for (const host of hosts) {
    if (seen.has(host) || seen.size >= SPF_MAX_LOOKUPS) continue
    seen.add(host)
    const records = await txt(host)
    if (!records) { failed = true; continue }
    const next = spfRecord(records)
    const covers = next ? await spfCovers(next, seen) : false
    if (covers) return true
    if (covers === null) failed = true
  }
  return failed ? null : false
}

export async function checkDomain(raw: string, extraSelector?: string): Promise<DomainCheck> {
  const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^.*@/, '')
  const selectors = [...new Set([extraSelector?.trim(), ...DKIM_SELECTORS].filter(Boolean) as string[])]
  const [mxFound, root, dmarcTxt, dkim] = await Promise.all([
    lookup(() => resolveMx(domain), []).then(r => r && r.sort((a, b) => a.priority - b.priority).map(m => m.exchange)),
    txt(domain),
    txt(`_dmarc.${domain}`),
    // '' = no key at that selector, null = the lookup failed
    Promise.all(selectors.map(async s => { const r = await txt(`${s}._domainkey.${domain}`); return r && (r.some(v => /v=DKIM1|p=/i.test(v)) ? s : '') })),
  ])
  const mx = mxFound ?? []
  const spf = root ? spfRecord(root) : null
  const dmarc = dmarcTxt?.find(r => /^v=dmarc1/i.test(r)) ?? null
  const dkimSelector = dkim.find(Boolean) ?? null
  const spfCoversSending = spf ? await spfCovers(spf) : root ? false : null
  const dmarcPolicy = dmarc ? /\bp=(\w+)/i.exec(dmarc)?.[1]?.toLowerCase() ?? null : null
  const unchecked = [
    spfCoversSending === null && 'SPF',
    !dkimSelector && dkim.includes(null) && 'DKIM',
    !dmarcTxt && 'DMARC',
    !mxFound && 'MX',
  ].filter(Boolean) as string[]

  const issues: string[] = []
  let score = 100
  if (!spf && !unchecked.includes('SPF')) { score -= 30; issues.push('SPF record missing.') }
  else if (spf && spfCoversSending === false) { score -= 10; issues.push("SPF exists but doesn't include secureserver.net (GoDaddy) or _spf.google.com (Google Workspace), so it doesn't cover your inboxes.") }
  if (!dkimSelector && !unchecked.includes('DKIM')) {
    score -= 30
    issues.push(`DKIM not found (tried ${selectors.length} common selectors, including GoDaddy's secureserver1/secureserver2 and Google's google). Add the DKIM record from GoDaddy's Email & Office Dashboard or Google Admin → Gmail → Authenticate email.`)
  }
  if (!dmarc && !unchecked.includes('DMARC')) { score -= 25; issues.push('DMARC record missing.') }
  else if (dmarc && !dkimSelector && !unchecked.includes('DKIM') && (dmarcPolicy === 'quarantine' || dmarcPolicy === 'reject')) {
    issues.push(`DMARC is set to "${dmarcPolicy}", so without DKIM, any email that fails SPF goes to spam or is rejected.`)
  }
  if (!mx.length && !unchecked.includes('MX')) { score -= 25; issues.push('MX records missing, so replies have nowhere to go.') }
  if (unchecked.length) {
    issues.push(`Couldn't check ${unchecked.join(' and ').replace(/ and (?=.* and )/g, ', ')} just now because the DNS lookup failed, so ${unchecked.length > 1 ? "they're" : "it's"} left out of the score. Re-check in a minute.`)
  }

  score = Math.max(0, Math.min(100, score))
  const [mode, label, cap]: [DomainCheck['mode'], string, number | null] =
    score >= 90 ? ['green', 'Ready for normal paced sending', null]
      : score >= 65 ? ['yellow', 'Limited warm-up mode', 40]
        : ['red', 'Setup required', 10]
  return { domain, score, mode, label: unchecked.length ? `${label} (some checks failed)` : label, cap, mx, spf, spfCoversSending, dkimSelector, dmarc, dmarcPolicy, unchecked, issues }
}
