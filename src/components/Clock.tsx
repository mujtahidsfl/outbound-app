import { useEffect, useState } from 'react'
import { TIME_ZONE } from '../tracking'

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' })

/** Live Eastern Time clock for the top bar. Ticks on its own so the rest of the page doesn't re-render every second. */
export default function Clock() {
  const [t, setT] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <time className="clock" dateTime={t.toISOString()} title="Eastern Time. Daily targets, due dates and the send window follow this clock.">
      <span className="clock-time">{timeFmt.format(t)}</span>
      <span className="clock-date">{dateFmt.format(t)}</span>
    </time>
  )
}
