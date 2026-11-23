import { useEffect, useMemo, useState } from 'react'
import { BackendError, fetchCalendarFeed } from '../api/backend'
import { getCalendarEvents, readUserRecord, writeUserRecord } from '../api/portalData'
import { readSessionToken } from '../auth/session'
import type { CalendarEvent } from '../models/calendar'
import type { User } from '../models/users'
import { parseIcs } from './events'

interface StoredPersonalEvent {
  uid: string
  summary: string
  start: string
  end?: string
  location?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCalendarSettings(value: unknown): string {
  if (value === null) return ''
  if (!isRecord(value) || typeof value.icsUrl !== 'string') {
    throw new Error('Calendar settings saved in your account are invalid.')
  }
  return value.icsUrl
}

function parsePersonalEvents(value: unknown): CalendarEvent[] {
  if (value === null) return []
  if (!Array.isArray(value)) throw new Error('Personal events saved in your account are invalid.')
  return value.map((event) => {
    if (!isRecord(event) || typeof event.uid !== 'string' || typeof event.summary !== 'string' ||
      typeof event.start !== 'string' || (event.end !== undefined && typeof event.end !== 'string') ||
      (event.location !== undefined && typeof event.location !== 'string')) {
      throw new Error('A personal event saved in your account is invalid.')
    }
    const start = new Date(event.start)
    const end = typeof event.end === 'string' ? new Date(event.end) : undefined
    if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) {
      throw new Error('A personal event saved in your account has an invalid date.')
    }
    return {
      uid: event.uid,
      summary: event.summary,
      start,
      end,
      location: typeof event.location === 'string' ? event.location : '',
      category: 'personal',
      allDay: false,
      exdates: [],
    }
  })
}

function toStoredPersonalEvent(event: CalendarEvent): StoredPersonalEvent {
  return {
    uid: event.uid,
    summary: event.summary,
    start: event.start.toISOString(),
    ...(event.end ? { end: event.end.toISOString() } : {}),
    ...(event.location ? { location: event.location } : {}),
  }
}

// Most calendar providers block cross-origin requests, so feeds go through a
// proxy: the Vite /api/ics-proxy under `npm run dev`, and the backend's
// /v1/calendar/ics in built (hosted) apps. If the deployed backend predates
// that route (404), fall back to fetching the feed directly, which only works
// for feeds that send CORS headers.
async function fetchIcsFeed(icsUrl: string): Promise<string> {
  if (import.meta.env.DEV) {
    const response = await fetch(`/api/ics-proxy?url=${encodeURIComponent(icsUrl)}`)
    if (!response.ok) throw new Error(`Failed to load calendar (${response.status})`)
    return response.text()
  }
  const token = readSessionToken()
  if (!token) throw new Error('Sign in again to load your calendar.')
  try {
    return await fetchCalendarFeed(token, icsUrl)
  } catch (error) {
    if (!(error instanceof BackendError && error.status === 404)) throw error
  }
  let response: Response
  try {
    response = await fetch(icsUrl.replace(/^webcal:\/\//i, 'https://'))
  } catch {
    throw new Error('This calendar feed does not allow loading from the browser, and the ServiceUNSW service has no iCal proxy yet.')
  }
  if (!response.ok) throw new Error(`Failed to load calendar (${response.status})`)
  return response.text()
}

export function useCalendarData(user: User) {
  const userId = user.id
  const [icsUrl, setIcsUrl] = useState('')
  const [feedRevision, setFeedRevision] = useState(0)
  const [importedEvents, setImportedEvents] = useState<CalendarEvent[]>([])
  const [personalEvents, setPersonalEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [personalEventsError, setPersonalEventsError] = useState<string | null>(null)
  const [personalEventsReady, setPersonalEventsReady] = useState(false)
  const [today] = useState(() => new Date())
  // Demo deadlines, campus events and (for professors) lectures are bundled with the app.
  const [{ serverEvents, serverEventsError }] = useState(() => {
    try {
      return { serverEvents: getCalendarEvents(user, today), serverEventsError: null }
    } catch (eventsError) {
      console.error('Unable to build calendar events:', eventsError)
      return { serverEvents: [], serverEventsError: 'Unable to load university and lecture events.' }
    }
  })

  useEffect(() => {
    let cancelled = false
    readUserRecord(userId, 'calendar-settings')
      .then((value) => {
        if (cancelled) return
        const url = parseCalendarSettings(value)
        setIcsUrl(url)
        setLoading(!!url)
      })
      .catch((settingsError: unknown) => {
        console.error('Unable to read calendar settings:', settingsError)
        if (cancelled) return
        setError('Unable to read saved calendar settings from your ServiceUNSW account.')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [userId])

  useEffect(() => {
    let cancelled = false
    readUserRecord(userId, 'personal-events')
      .then((value) => {
        if (cancelled) return
        setPersonalEvents(parsePersonalEvents(value))
        setPersonalEventsReady(true)
      })
      .catch((eventsError: unknown) => {
        console.error('Unable to read personal events:', eventsError)
        if (!cancelled) setPersonalEventsError('Unable to load personal events from your ServiceUNSW account.')
      })
    return () => { cancelled = true }
  }, [userId])

  useEffect(() => {
    if (!icsUrl) return
    let cancelled = false
    fetchIcsFeed(icsUrl)
      .then((text) => {
        if (!cancelled) setImportedEvents(parseIcs(text))
      })
      .catch((fetchError: unknown) => {
        if (cancelled) return
        setError(fetchError instanceof Error ? fetchError.message : 'Failed to load calendar')
        setImportedEvents([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [icsUrl, feedRevision])

  const events = useMemo(
    () => [...(icsUrl ? importedEvents : []), ...serverEvents, ...personalEvents],
    [icsUrl, importedEvents, serverEvents, personalEvents],
  )

  async function saveIcsUrl(url: string) {
    const savedUrl = parseCalendarSettings(await writeUserRecord(userId, 'calendar-settings', { icsUrl: url }))
    setImportedEvents([])
    setError(null)
    setLoading(!!savedUrl)
    setIcsUrl(savedUrl)
    setFeedRevision((previous) => previous + 1)
  }

  async function addPersonalEvent(event: CalendarEvent) {
    if (!personalEventsReady) {
      throw new Error('Personal events must finish loading before adding a new event.')
    }
    const saved = await writeUserRecord(
      userId,
      'personal-events',
      [...personalEvents, event].map(toStoredPersonalEvent),
    )
    setPersonalEvents(parsePersonalEvents(saved))
    setPersonalEventsError(null)
  }

  return {
    today,
    events,
    icsUrl,
    loading,
    error,
    personalEventsError,
    personalEventsReady,
    serverEventsError,
    saveIcsUrl,
    addPersonalEvent,
  }
}

export type CalendarData = ReturnType<typeof useCalendarData>
