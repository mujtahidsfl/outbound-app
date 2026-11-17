export interface Lead {
  id: string
  wave: number
  nicheGroup: string
  score: number
  hook: string
  pitchAngle: string
  emailType: string
  businessName: string
  industry: string
  niche: string
  specificCategory: string
  whatTheyDo: string
  city: string
  address: string
  rating: number | null
  reviews: number | null
  websiteStatus: string
  website: string
  whyOutdated: string
  email: string
  emailFoundAt: string
  googleMaps: string
}

/** An uploaded file (in the lead-media storage bucket) or a pasted link. */
export interface MediaItem {
  name: string
  path?: string
  url?: string
  type?: string
  size?: number
}

/** Outreach state for one lead. Dates are local YYYY-MM-DD strings. */
export interface Track {
  sentAt?: string
  followUps: string[]
  repliedAt?: string
  badReason?: string
  notes?: string
  mediaDone?: boolean
  media?: MediaItem[]
  /** Inbox the sequence goes out from. Follow-ups reply in the same thread, so one inbox per lead. */
  inbox?: string
  /** Pipeline after a reply (see STAGES), when each stage was reached, and the deal value once won. */
  stage?: Stage
  stageLog?: Partial<Record<Stage, string>>
  dealValue?: number
}

export const STAGES = ['replied', 'loom_requested', 'loom_sent', 'call_booked', 'proposal', 'won', 'lost', 'not_interested'] as const
export type Stage = (typeof STAGES)[number]

export type ReplyIntent = 'loom' | 'meeting' | 'interested' | 'question' | 'not_interested' | 'other'

/** One wording of a sequence email. A blank subject on a follow-up keeps it in the thread of the email before it. */
export interface SequenceVariant { subject: string; body: string }

/** One email of a campaign written in the app: `gap` days after the previous email, in one or more variants. */
export interface SequenceStep { gap: number; variants: SequenceVariant[] }

/** What starts a subsequence: a reply sorted into that category, or how the lead behaved without replying. */
export const SUBSEQUENCE_TRIGGERS = ['interested', 'meeting', 'question', 'other', 'finished', 'opened', 'clicked'] as const
export type SubsequenceTrigger = (typeof SUBSEQUENCE_TRIGGERS)[number]

export interface Subsequence {
  id: string
  name: string
  trigger: SubsequenceTrigger
  enabled: boolean
  steps: { gap: number; body: string }[]
}

export type RecipientEsp = 'google' | 'outlook' | 'other'

/** Everything set on a campaign's pages. Unset fields keep the app-wide behavior, so imported campaigns are unchanged. */
export interface CampaignConfig {
  folder?: string
  /** Set on campaigns written in the app. Imported campaigns keep each lead's written emails in campaign_leads. */
  sequence?: SequenceStep[]
  /** Sender accounts this campaign uses. Empty = all of them. */
  inboxes?: string[]
  subsequences?: Subsequence[]
  /** IANA zone, days (0 = Sunday) and hours (24h: start inclusive, end exclusive). Unset = the app-wide window. */
  timeZone?: string
  days?: number[]
  startHour?: number
  endHour?: number
  /** New leads started per day, across all sender accounts. Unset = no limit beyond each account's cap. */
  newLeadsPerDay?: number
  /** Stop the sequence for a lead who opens or clicks. Replies always stop it. */
  stopOnOpen?: boolean
  stopOnClick?: boolean
  /** How leads split across variants: pattern = A, B, C in list order; even = whichever has gone out least; random. */
  variantDistribution?: 'pattern' | 'even' | 'random'
  /** Stop everyone else at the same company domain once one person there replies. */
  companyAutoPause?: boolean
  /** Share of each day's sends that may go to follow-ups (0-100). Unset = 100: follow-ups always first. */
  followUpShare?: number
  /** New leads go out from a sender on the same provider as them, when the campaign has one. */
  espMatching?: boolean
  /** No HTML at all, so no open pixel or tracked links. */
  plainText?: boolean
  /** Unset = the app-wide open tracking setting. */
  trackOpens?: boolean
  trackClicks?: boolean
  /** Providers to email. Empty = everyone. */
  providers?: RecipientEsp[]
  /** Pause this campaign once bounces reach `threshold` percent. */
  bounceProtection?: { enabled: boolean; threshold: number; since?: string }
  /** Most emails per day to one recipient domain. */
  domainDailyLimit?: number
  /** No longer read: since 2026-11-07 every email ends with the unsubscribe link, whatever this says. */
  unsubscribeLink?: boolean
  /** The words that carry the unsubscribe link. Unset = "Unsubscribe". */
  unsubscribeText?: string
  /** Why the app paused this campaign. */
  pausedReason?: string
}

/** One email of a campaign's written sequence. Steps are 1-based here; email_messages.step is 0-based. */
export interface CampaignStep {
  n: number
  day: number
  /** 'new' starts its own thread with its own subject; 'reply' answers the thread started by `replyTo`. */
  thread: 'new' | 'reply'
  replyTo?: number
  /** Attach the campaign's screenshots to this email. */
  attachImages?: boolean
}

export interface Campaign {
  id: string
  name: string
  status: 'active' | 'paused' | 'done'
  followUpsPaused: boolean
  /** Autopilot sends nothing before this ET date. */
  startDate: string | null
  cadence: number[]
  steps: CampaignStep[]
  images: MediaItem[]
  /** Optional subject B per email number ("1", "2"); leads split 50/50 when set. */
  subjectB: Record<string, string>
  /** Send statuses that go out without a manual approve. */
  autoStatuses: string[]
  config: CampaignConfig
}

/** A lead's place in a campaign. The written emails are fetched separately (they're large). */
export interface CampaignLead {
  campaignId: string
  leadId: string
  position: number
  leadNo: number | null
  sendStatus: 'READY' | 'CHECK FIRST' | 'DO NOT SEND'
  approved: boolean
  toEmail: string
  businessName: string
  shortName: string
  trade: string
  city: string
  rating: number | null
  reviews: number | null
  website: string
  offer: string
  tier: string
  price: number | null
  checks: string[]
  icebreaker: string
  subjectNoun: string | null
  subjectOwner: string | null
  /** Columns of an uploaded lead list, for {{variables}} in the sequence. */
  vars?: Record<string, string>
}

export interface CampaignEmail {
  step: number
  day: number
  thread: 'new' | 'reply'
  replyTo: number | null
  subject: string
  body: string
  /** Index of the sequence variant used (campaigns written in the app). */
  variant?: number
}

export type TrackMap = Record<string, Track>

/** One inbox's row in the inbox_guard table ('*' = every inbox). */
export interface InboxGuard {
  /** This inbox's own warm-up week 1 (YYYY-MM-DD), set on its first send. */
  warmupStart?: string | null
}

export interface Settings {
  /** Days to wait after the previous touch before each follow-up. */
  cadence: number[]
  dailyTarget: number
  /** Total emails to send each day, counting first emails and every follow-up step. */
  dailyEmailTarget: number
  /** Sending inboxes, each capped at inboxDailyLimit emails a day. */
  inboxes: string[]
  inboxDailyLimit: number
  /** Inboxes that no longer send but are still checked for replies, opt-outs and bounces to what they sent. */
  retiredInboxes?: string[]
  /** A fixed daily cap for one inbox, every day, in place of inboxDailyLimit. The warm-up ramp still holds it down while it's on it. */
  inboxLimits?: Record<string, number>
  /** A send count set by hand on Email accounts for one inbox, for that day only (ET). It replaces the ramp for the day. */
  sendsToday?: Record<string, { day: string; n: number }>
  /** Autopilot sends due follow-ups and new first emails on its own during the send window. */
  autopilot: boolean
  /** Send window, Eastern Time, 24h clock: start hour inclusive, end hour exclusive. */
  sendStartHour: number
  sendEndHour: number
  sendWeekdaysOnly: boolean
  /** Inboxes on the warm-up ramp. The others send inboxDailyLimit from day one. */
  warmupInboxes: string[]
  /** Per-inbox daily cap for each week of warm-up; after the last week, inboxDailyLimit. */
  warmupCaps: number[]
  /** First warm-up day (YYYY-MM-DD, ET). Empty until the app sends its first email. */
  warmupStart: string
  /**
   * Loaded from inbox_guard (guard.sql), never saved in app_settings. Once present, each inbox ramps from its own
   * warmupStart and an inbox without one hasn't started (week 1).
   */
  guard?: Record<string, InboxGuard>
  /** Where positive replies (right away) and the end-of-day digest (everything else) are emailed. Empty = dashboard only. */
  alertEmail?: string
  /** ET day the end-of-day digest last went out (YYYY-MM-DD); set by the server. */
  digestSentOn?: string
  /** No longer read: open tracking is switched in code (TRACK_OPENS in api/_lib/env.ts), and it's off. */
  trackOpens?: boolean
  /** Only email addresses whose mail Google hosts (gmail.com or Google Workspace); everyone else is skipped. Unset = on. */
  googleOnly?: boolean
  /** Gmail accounts that get every inbox's Email 1 each sending morning, to see if it lands in Primary, a tab or Spam (needs seed.sql). */
  seedInboxes?: string[]
  /** Sender identity and postal address for the CAN-SPAM footer. Sending stays blocked until both are set. */
  companyName: string
  mailingAddress: string
  senderName: string
  firstSubject: string
  firstBody: string
  followUpSubject: string
  followUpBody: string
}

export type Status = 'new' | 'awaiting' | 'due' | 'replied' | 'done' | 'bad'

export interface Derived {
  status: Status
  /** Next follow-up date, when the lead is in an active sequence. */
  nextDue?: string
  touches: number
}

export const BAD_REASONS = [
  'Bounced',
  'Invalid email',
  'Wrong business',
  'Business closed',
  'Duplicate',
  'Unsubscribed',
  'Not interested',
  'Company replied',
  'Other',
] as const
