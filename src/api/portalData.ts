// Portal data for the signed-in user, with no server of its own.
//
// - Catalogue data (seeded role profiles, services, lecture schedule, demo
//   events, timesheet settings) is bundled from src/data/.
// - Per-user state (favourites, calendar settings, personal events, lecture
//   checklists, teaching note, timesheet entries) is saved in the backend's
//   key-value store through userData.ts. A record that was never saved falls
//   back to the starting data in src/data/ (e.g. seeded teaching notes).
//
// Validation the old mock API did on its server runs here, before saving. This
// is a demo: anyone with the account's JWT can write any value to the store.

import demoEventRows from '../data/demoCalendarEvents.json'
import lectureSchedule from '../data/lectureSchedule.json'
import serviceTable from '../data/services.json'
import seededTeachingNotes from '../data/teachingNotes.json'
import seededTimesheets from '../data/timesheets.json'
import timesheetSettings from '../data/timesheetSettings.json'
import seededUsers from '../data/users.json'
import type { CalendarCategory, CalendarEvent } from '../models/calendar'
import type { LecturePlan, LectureWeekday } from '../models/lectures'
import type { QuickLinkService, ServiceCatalogue, ServiceGroup } from '../models/services'
import type { TimesheetEntry, TimesheetEntryInput, TimesheetPeriod, Timesheets } from '../models/timesheets'
import type { User } from '../models/users'
import type { BackendUser } from './backend'
import { readRecord, writeRecord } from './userData'

export type UserResource =
  | 'favourites'
  | 'calendar-settings'
  | 'personal-events'
  | 'lecture-checklists'
  | 'teaching-note'

const MAX_FAVOURITES = 4
const MAX_PERSONAL_EVENTS = 200
const MAX_TIMESHEET_ENTRIES = 300
const SERVICE_ID_PATTERN = /^[a-z0-9-]{1,64}$/
const LECTURE_KEY_PATTERN = /^[A-Z]{4}\d{4}-\d{4}-\d{2}-\d{2}$/
const ZID_PATTERN = /^z[0-9]{7}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const users = seededUsers as Record<string, User>
const services = serviceTable as { groups: ServiceGroup[]; services: QuickLinkService[]; defaultFavourites: string[] }
const schedule = lectureSchedule as {
  periodStart: string
  periodEnd: string
  defaultDays: string[]
  professorDays: Record<string, string[]>
  slots: { startTime: string; endTime: string; location: string }[]
}
const demoEvents = demoEventRows as {
  uid: string
  summary: string
  location?: string
  dayOffset: number
  startHour: number
  endHour?: number
  category: CalendarCategory
  url?: string
}[]
const teachingNotes = seededTeachingNotes as Record<string, { note: string }>
const timesheetSeed = seededTimesheets as Record<string, TimesheetEntry[]>

export class ValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(value: unknown, field: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text.`)
  const trimmed = value.trim()
  if ((!allowEmpty && trimmed.length === 0) || trimmed.length > maxLength) {
    throw new ValidationError(`${field} must be ${allowEmpty ? 'at most ' : '1-'}${maxLength} characters.`)
  }
  return trimmed
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a valid date.`)
  }
  return new Date(value).toISOString()
}

// ---------------------------------------------------------------------------
// Profile

/**
 * Returns the portal profile for an account the backend has signed in.
 * A zID matching a seeded profile keeps its roles and teaching appointments;
 * any other zID gets a student profile. Names and degree come from the backend.
 */
export function linkProfile(account: BackendUser): User {
  const zId = account.zId.toLowerCase()
  if (!ZID_PATTERN.test(zId)) throw new ValidationError('zId must be z followed by seven digits.')
  const seeded = Object.values(users).find((candidate) => candidate.universityId === zId)
  const base: User = seeded ?? {
    id: zId,
    name: account.firstName,
    fullName: '',
    email: `${zId}@ad.unsw.edu.au`,
    universityId: zId,
    school: 'UNSW Sydney',
    roles: ['student'],
    degree: {
      name: account.degree,
      studyStage: 'Full-time',
      currentTerm: 'Term 3, 2026',
      completedUoc: 0,
      requiredUoc: 144,
    },
    teachingAppointments: [],
  }
  return {
    ...base,
    name: account.firstName,
    fullName: `${account.firstName} ${account.lastName}`,
    ...(base.degree ? { degree: { ...base.degree, name: account.degree } } : {}),
  }
}

// ---------------------------------------------------------------------------
// Catalogue data

export function getServiceCatalogue(user: User): ServiceCatalogue {
  return {
    groups: services.groups,
    services: services.services.map((service) =>
      service.id === 'myplan' && user.roles.includes('student') && user.degree
        ? { ...service, description: `Plan your ${user.degree.name} pathway.` }
        : service),
  }
}

export function getLecturePlan(user: User): LecturePlan {
  if (!user.roles.includes('professor')) throw new Error('Lecture plans are only available to professors.')
  const days = schedule.professorDays[user.id] ?? schedule.defaultDays
  const sessions: LecturePlan['sessions'] = []
  const end = new Date(`${schedule.periodEnd}T00:00:00Z`)
  for (const date = new Date(`${schedule.periodStart}T00:00:00Z`); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const weekday = WEEKDAYS[date.getUTCDay()]
    const slot = schedule.slots[days.indexOf(weekday)]
    if (!slot) continue
    sessions.push({
      date: new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12),
      weekday: weekday as LectureWeekday,
      ...slot,
    })
  }
  return {
    courses: user.teachingAppointments.filter((appointment) => appointment.role === 'professor'),
    sessions,
  }
}

/** Demo deadlines and campus events (dated relative to `now`), plus lectures for professors. */
export function getCalendarEvents(user: User, now = new Date()): CalendarEvent[] {
  const at = (dayOffset: number, hour: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour)
  const demo: CalendarEvent[] = demoEvents.map(({ dayOffset, startHour, endHour, ...event }) => ({
    ...event,
    start: at(dayOffset, startHour),
    end: endHour === undefined ? undefined : at(dayOffset, endHour),
    allDay: false,
    exdates: [],
    demo: true,
  }))
  if (!user.roles.includes('professor')) return demo
  const { courses, sessions } = getLecturePlan(user)
  const lectures: CalendarEvent[] = courses.flatMap((course) => sessions.map((session) => {
    const [startHour, startMinute] = session.startTime.split(':').map(Number)
    const [endHour, endMinute] = session.endTime.split(':').map(Number)
    const day = session.date
    const localDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    return {
      uid: `lecture-${course.courseCode}-${localDate}`,
      summary: `${course.courseCode} · ${course.courseName} lecture`,
      location: session.location,
      // Local time, so each lecture sits at its scheduled time in the viewer's timezone.
      start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, startMinute),
      end: new Date(day.getFullYear(), day.getMonth(), day.getDate(), endHour, endMinute),
      allDay: false,
      exdates: [],
      category: 'lecture' as const,
    }
  }))
  return [...lectures, ...demo]
}

// ---------------------------------------------------------------------------
// Per-user records

function normaliseFavourites(stored: unknown): string[] {
  const ids = Array.isArray(stored) ? stored : services.defaultFavourites
  const known = new Set(services.services.map((service) => service.id))
  return [...new Set(ids.map((id) => id === 'fees' ? 'myplan' : id))]
    .filter((id): id is string => typeof id === 'string' && known.has(id))
    .slice(0, MAX_FAVOURITES)
}

function validateFavourites(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_FAVOURITES ||
    value.some((id) => typeof id !== 'string' || !SERVICE_ID_PATTERN.test(id)) ||
    new Set(value).size !== value.length) {
    throw new ValidationError('Favourites must contain up to four unique service IDs.')
  }
  if (value.some((id) => !services.services.some((service) => service.id === id))) {
    throw new ValidationError('Favourites can only include available services.')
  }
  return value
}

function validateCalendarSettings(value: unknown): { icsUrl: string } {
  if (!isRecord(value)) throw new ValidationError('Calendar settings must be an object.')
  const icsUrl = requireText(value.icsUrl, 'iCal link', 2048, true)
  if (icsUrl) {
    let url: URL
    try {
      url = new URL(icsUrl)
    } catch {
      throw new ValidationError('Enter a valid iCal URL.')
    }
    if (!['https:', 'http:', 'webcal:'].includes(url.protocol)) {
      throw new ValidationError('Use an HTTPS, HTTP or webcal calendar link.')
    }
  }
  return { icsUrl }
}

function validatePersonalEvents(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_PERSONAL_EVENTS) {
    throw new ValidationError(`You can save up to ${MAX_PERSONAL_EVENTS} personal events.`)
  }
  const ids = new Set<string>()
  return value.map((event, index) => {
    if (!isRecord(event)) throw new ValidationError(`Personal event ${index + 1} must be an object.`)
    const uid = requireText(event.uid, 'Event ID', 100)
    if (ids.has(uid)) throw new ValidationError('Personal event IDs must be unique.')
    ids.add(uid)
    const start = requireDate(event.start, 'Event start')
    const end = event.end === undefined ? undefined : requireDate(event.end, 'Event end')
    if (end && Date.parse(end) <= Date.parse(start)) throw new ValidationError('Event end must be after its start.')
    const location = event.location === undefined ? '' : requireText(event.location, 'Event location', 200, true)
    return {
      uid,
      summary: requireText(event.summary, 'Event title', 200),
      start,
      ...(end ? { end } : {}),
      ...(location ? { location } : {}),
    }
  })
}

function validateLectureChecklists(value: unknown) {
  if (!isRecord(value)) throw new ValidationError('Lecture checklists must be an object.')
  return Object.fromEntries(Object.entries(value).map(([lectureKey, items]) => {
    if (!LECTURE_KEY_PATTERN.test(lectureKey)) throw new ValidationError('Invalid lecture key.')
    if (!Array.isArray(items) || items.length > 50) {
      throw new ValidationError('Each lecture checklist can contain up to 50 items.')
    }
    const ids = new Set<string>()
    return [lectureKey, items.map((item) => {
      if (!isRecord(item) || typeof item.checked !== 'boolean') {
        throw new ValidationError('Each checklist item must include a checked state.')
      }
      const id = requireText(item.id, 'Checklist item ID', 100)
      if (ids.has(id)) throw new ValidationError('Checklist item IDs must be unique.')
      ids.add(id)
      return { id, text: requireText(item.text, 'Checklist item', 200), checked: item.checked }
    })]
  }))
}

function validateTeachingNote(value: unknown): { note: string } {
  if (!isRecord(value)) throw new ValidationError('Teaching note must be an object.')
  return { note: requireText(value.note, 'Teaching note', 5000, true) }
}

const validators: Record<UserResource, (value: unknown) => unknown> = {
  'favourites': validateFavourites,
  'calendar-settings': validateCalendarSettings,
  'personal-events': validatePersonalEvents,
  'lecture-checklists': validateLectureChecklists,
  'teaching-note': validateTeachingNote,
}

/** Returns the saved record, its starting value for seeded profiles, or `null`. */
export async function readUserRecord(userId: string, resource: UserResource): Promise<unknown> {
  const stored = await readRecord(resource)
  if (resource === 'favourites') return normaliseFavourites(stored)
  if (stored !== undefined) return stored
  if (resource === 'teaching-note' && Object.hasOwn(teachingNotes, userId)) return teachingNotes[userId]
  return null
}

/** Validates and saves the record, then returns the saved value. */
export async function writeUserRecord(_userId: string, resource: UserResource, value: unknown): Promise<unknown> {
  const validated = validators[resource](value)
  await writeRecord(resource, validated)
  return validated
}

// ---------------------------------------------------------------------------
// Timesheets

function localDateString(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function buildTimesheetPeriods(today: string): TimesheetPeriod[] {
  const periods: TimesheetPeriod[] = []
  const { firstPeriodStart, periodLengthDays, openPeriodCount } = timesheetSettings
  for (let start = firstPeriodStart; start <= today || periods.length === 0; start = addDays(start, periodLengthDays)) {
    periods.push({ start, end: addDays(start, periodLengthDays - 1), status: 'closed' })
  }
  periods.slice(-openPeriodCount).forEach((period) => { period.status = 'open' })
  return periods.reverse()
}

function timesheetContext(user: User) {
  if (!user.roles.includes('tutor')) throw new Error('Timesheets are only available to tutors.')
  const today = localDateString(new Date())
  return {
    today,
    activities: timesheetSettings.activities,
    periods: buildTimesheetPeriods(today),
    courses: user.teachingAppointments
      .filter((appointment) => appointment.role === 'tutor')
      .map(({ courseCode, courseName, coordinator }) => ({ courseCode, courseName, coordinator })),
  }
}

type TimesheetContext = ReturnType<typeof timesheetContext>

async function readEntries(user: User): Promise<TimesheetEntry[]> {
  const stored = await readRecord('timesheets')
  if (stored === undefined) return timesheetSeed[user.id] ?? []
  if (!Array.isArray(stored)) throw new Error('Saved timesheets are invalid.')
  return stored as TimesheetEntry[]
}

function sortEntries(entries: TimesheetEntry[]): TimesheetEntry[] {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime))
}

function toTimesheets(context: TimesheetContext, entries: TimesheetEntry[]): Timesheets {
  return { ...context, entries: sortEntries(entries) }
}

function validateTimesheetEntry(value: TimesheetEntryInput, context: TimesheetContext): TimesheetEntryInput {
  const courseCode = requireText(value.courseCode, 'Course', 20)
  if (!context.courses.some((course) => course.courseCode === courseCode)) {
    throw new ValidationError('Choose a course you tutor.')
  }
  const date = requireText(value.date, 'Date', 10)
  if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new ValidationError('Enter a valid date.')
  }
  if (date > context.today) throw new ValidationError('You cannot record hours for a future date.')
  const period = context.periods.find((candidate) => candidate.start <= date && date <= candidate.end)
  if (!period || period.status !== 'open') {
    throw new ValidationError('Hours can only be recorded in an open reporting period.')
  }
  const activity = requireText(value.activity, 'Activity', 50)
  if (!context.activities.includes(activity)) throw new ValidationError('Choose a valid activity.')
  const startTime = requireText(value.startTime, 'Start time', 5)
  const endTime = requireText(value.endTime, 'End time', 5)
  if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)) {
    throw new ValidationError('Enter valid start and end times.')
  }
  const duration = minutesOf(endTime) - minutesOf(startTime)
  if (duration <= 0) throw new ValidationError('End time must be after start time.')
  if (duration > 12 * 60) throw new ValidationError('A single entry cannot exceed 12 hours.')
  const notes = value.notes === undefined ? '' : requireText(value.notes, 'Notes', 200, true)
  return { courseCode, date, activity, startTime, endTime, notes }
}

function assertNoOverlap(entries: TimesheetEntry[], entry: TimesheetEntryInput, ignoreId?: string) {
  const start = minutesOf(entry.startTime)
  const end = minutesOf(entry.endTime)
  const overlapping = entries.find((other) => other.id !== ignoreId && other.date === entry.date &&
    minutesOf(other.startTime) < end && start < minutesOf(other.endTime))
  if (overlapping) {
    throw new ValidationError(`These times overlap your ${overlapping.activity.toLowerCase()} entry (${overlapping.startTime}–${overlapping.endTime}).`)
  }
}

/** Finds a draft entry in an open period, the only kind that can change. */
function editableEntry(entries: TimesheetEntry[], entryId: string, context: TimesheetContext): TimesheetEntry {
  const existing = entries.find((entry) => entry.id === entryId)
  if (!existing) throw new ValidationError('Timesheet entry not found.')
  if (existing.status !== 'draft') throw new ValidationError('Only draft entries can be changed.')
  const period = context.periods.find((candidate) => candidate.start <= existing.date && existing.date <= candidate.end)
  if (period?.status !== 'open') throw new ValidationError('This reporting period is closed.')
  return existing
}

async function saveEntries(context: TimesheetContext, entries: TimesheetEntry[]): Promise<Timesheets> {
  await writeRecord('timesheets', entries)
  return toTimesheets(context, entries)
}

export async function fetchTimesheets(user: User): Promise<Timesheets> {
  const context = timesheetContext(user)
  return toTimesheets(context, await readEntries(user))
}

export async function createTimesheetEntry(user: User, entry: TimesheetEntryInput, submit: boolean): Promise<Timesheets> {
  const context = timesheetContext(user)
  const fields = validateTimesheetEntry(entry, context)
  const entries = await readEntries(user)
  if (entries.length >= MAX_TIMESHEET_ENTRIES) throw new ValidationError('Too many timesheet entries.')
  assertNoOverlap(entries, fields)
  return saveEntries(context, [...entries, { id: crypto.randomUUID(), ...fields, status: submit ? 'submitted' : 'draft' }])
}

export async function updateTimesheetEntry(user: User, entryId: string, entry: TimesheetEntryInput, submit: boolean): Promise<Timesheets> {
  const context = timesheetContext(user)
  const fields = validateTimesheetEntry(entry, context)
  const entries = await readEntries(user)
  editableEntry(entries, entryId, context)
  assertNoOverlap(entries, fields, entryId)
  return saveEntries(context, entries.map((existing) =>
    existing.id === entryId ? { ...existing, ...fields, status: submit ? 'submitted' : 'draft' } : existing))
}

export async function deleteTimesheetEntry(user: User, entryId: string): Promise<Timesheets> {
  const context = timesheetContext(user)
  const entries = await readEntries(user)
  editableEntry(entries, entryId, context)
  return saveEntries(context, entries.filter((existing) => existing.id !== entryId))
}
