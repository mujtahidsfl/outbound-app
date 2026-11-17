import type { Settings } from '../../types'

/** What the guard watches, in one paragraph. */
export function GuardRules({ settings }: { settings: Settings }) {
  if (!settings.guard) return <p className="small due-text cold-p">Deliverability guard not set up yet: run supabase/guard.sql in Supabase.</p>
  return (
    <p className="small muted cold-p">
      Guard on: it raises an alert when sends fail, the mail provider blocks an inbox, opens drop very low, many leads unsubscribe,
      SPF/DKIM go missing, or a test email lands in spam. It never pauses or caps an inbox. Bounces are counted per day on the dashboard.
    </p>
  )
}
