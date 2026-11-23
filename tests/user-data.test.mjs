// Portal records in the backend key-value store (`/v1/users/me/data`).
//
// By default this runs against an in-memory fake of the backend that, like the
// real one, rejects any stored value longer than VARCHAR(191). To run it against
// a real backend, set USER_DATA_TEST_API (e.g. http://127.0.0.1:3000) and
// USER_DATA_TEST_TOKEN (a JWT for a throwaway verified account; its portal.*
// keys are overwritten).
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { createServer } from 'vite'

const realApi = process.env.USER_DATA_TEST_API
const realToken = process.env.USER_DATA_TEST_TOKEN
const nativeFetch = globalThis.fetch

let server
let userData
let portal
let store
let requests

function fakeBackend(url, init = {}) {
  const { pathname, searchParams } = new URL(url, 'http://backend.test')
  const method = init.method ?? 'GET'
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
  if (pathname === '/runtime-config.json') return json(404)
  if (pathname !== '/v1/users/me/data') return json(404, { error: 'not found' })
  requests.push(method)
  if (method === 'GET') return json(200, Object.fromEntries([...store].map(([key, value]) => [key, JSON.parse(value)])))
  if (method === 'PATCH') {
    const entries = Object.entries(JSON.parse(init.body)).map(([key, value]) => [key, JSON.stringify(value)])
    if (entries.some(([, value]) => [...value].length > 191)) return json(500, { error: 'Internal Server Error' })
    for (const [key, value] of entries) store.set(key, value)
    return json(200, {})
  }
  if (method === 'DELETE') {
    const key = searchParams.get('key')
    if (!store.delete(key)) return json(404, { error: 'No user data with key found' })
    return new Response(null, { status: 204 })
  }
  return json(405, {})
}

before(async () => {
  globalThis.window = { sessionStorage: { getItem: () => realToken ?? 'test-token', setItem() {}, removeItem() {} } }
  globalThis.fetch = realApi
    ? (url, init) => nativeFetch(String(url).startsWith('/') ? `${realApi}${url}` : url, init)
    : async (url, init) => fakeBackend(String(url), init)
  if (realApi) {
    // Start from a clean slate so the fallback-to-seed assertions hold.
    const headers = { authorization: `Bearer ${realToken}` }
    const saved = await (await nativeFetch(`${realApi}/v1/users/me/data`, { headers })).json()
    for (const key of Object.keys(saved).filter((candidate) => candidate.startsWith('portal.'))) {
      await nativeFetch(`${realApi}/v1/users/me/data?key=${encodeURIComponent(key)}`, { method: 'DELETE', headers })
    }
  }
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
  userData = await server.ssrLoadModule('/src/api/userData.ts')
  portal = await server.ssrLoadModule('/src/api/portalData.ts')
})

beforeEach(() => {
  store = new Map()
  requests = []
})

after(async () => {
  globalThis.fetch = nativeFetch
  delete globalThis.window
  await server?.close()
})

const sam = () => portal.linkProfile({ zId: 'z2460814', firstName: 'Sam', lastName: 'Rivera', dateOfBirth: 0, degree: 'BSc' })

test('records of any size round-trip without exceeding the 191-character column', async () => {
  const tricky = `"quoted" \\ backslash, emoji 😀🎉, café, newline\n${'long text '.repeat(500)}END`
  for (const value of [{ note: 'short' }, { note: tricky }, { note: '' }, ['a', 'b'], { nested: { deep: [1, 2, 3] } }]) {
    await userData.writeRecord('roundtrip-test', value)
    assert.deepEqual(await userData.readRecord('roundtrip-test'), value)
  }
  if (!realApi) {
    assert.ok([...store.values()].every((value) => [...value].length <= 191))
    assert.equal(requests.filter((method) => method === 'GET').length, 1, 'saved data is fetched once and cached')
  }
})

test('shrinking a record deletes the chunks it no longer uses', { skip: !!realApi }, async () => {
  await userData.writeRecord('shrink-test', { note: 'x'.repeat(2000) })
  const long = [...store.keys()].filter((key) => key.startsWith('portal.shrink-test#')).length
  assert.ok(long > 5)
  await userData.writeRecord('shrink-test', { note: 'y'.repeat(400) })
  const short = [...store.keys()].filter((key) => key.startsWith('portal.shrink-test#')).length
  assert.ok(short > 0 && short < long)
  await userData.writeRecord('shrink-test', { note: 'tiny' })
  assert.deepEqual([...store.keys()].filter((key) => key.startsWith('portal.shrink-test')), ['portal.shrink-test'])
})

test('seeded profiles keep their roles; other zIDs become students', () => {
  assert.deepEqual(sam().roles, ['tutor', 'professor'])
  assert.equal(sam().fullName, 'Sam Rivera')
  const student = portal.linkProfile({ zId: 'z5555555', firstName: 'Test', lastName: 'Student', dateOfBirth: 0, degree: 'BSc' })
  assert.deepEqual(student.roles, ['student'])
  assert.equal(student.degree.name, 'BSc')
})

test('per-user records fall back to starting data and validate before saving', async () => {
  const user = sam()
  assert.deepEqual(await portal.readUserRecord(user.id, 'favourites'), ['moodle', 'myunsw', 'library', 'email'])
  assert.match((await portal.readUserRecord(user.id, 'teaching-note')).note, /COMP1531/)
  await assert.rejects(portal.writeUserRecord(user.id, 'favourites', ['moodle', 'myunsw', 'library', 'email', 'myplan']), /up to four/)
  await assert.rejects(portal.writeUserRecord(user.id, 'favourites', ['not-a-service']), /available services/)
  await assert.rejects(portal.writeUserRecord(user.id, 'calendar-settings', { icsUrl: 'ftp://x' }), /HTTPS/)
  assert.deepEqual(await portal.writeUserRecord(user.id, 'favourites', ['library']), ['library'])
  assert.deepEqual(await portal.readUserRecord(user.id, 'favourites'), ['library'])
})

test('timesheet rules from the old mock API run in the browser', async () => {
  const user = sam()
  const initial = await portal.fetchTimesheets(user)
  const open = initial.periods.find((period) => period.status === 'open')
  const closed = initial.periods.find((period) => period.status === 'closed')
  const entry = { courseCode: initial.courses[0].courseCode, date: initial.today, activity: 'Tutorial', startTime: '09:00', endTime: '10:00', notes: 'test' }
  assert.ok(open)

  const created = await portal.createTimesheetEntry(user, entry, false)
  const draft = created.entries.find((candidate) => candidate.notes === 'test')
  assert.equal(draft.status, 'draft')
  await assert.rejects(portal.createTimesheetEntry(user, { ...entry, startTime: '09:30', endTime: '11:00' }, false), /overlap/)
  await assert.rejects(portal.createTimesheetEntry(user, { ...entry, date: '2999-01-01' }, false), /future/)
  if (closed) await assert.rejects(portal.createTimesheetEntry(user, { ...entry, date: closed.start }, false), /open reporting period/)
  await assert.rejects(portal.createTimesheetEntry(user, { ...entry, courseCode: 'COMP9999', startTime: '12:00', endTime: '13:00' }, false), /course you tutor/)

  const submitted = await portal.updateTimesheetEntry(user, draft.id, { ...entry, endTime: '10:30' }, true)
  assert.equal(submitted.entries.find((candidate) => candidate.id === draft.id).status, 'submitted')
  await assert.rejects(portal.deleteTimesheetEntry(user, draft.id), /Only draft/)
  assert.deepEqual((await portal.fetchTimesheets(user)).entries, submitted.entries)
})

test('lecture plans and calendar events come from the bundled schedule', () => {
  const user = sam()
  const plan = portal.getLecturePlan(user)
  assert.equal(plan.courses.length, 1)
  assert.ok(plan.sessions.length > 0 && plan.sessions.every((session) => ['Tuesday', 'Thursday'].includes(session.weekday)))
  const events = portal.getCalendarEvents(user, new Date(2026, 10, 1))
  assert.ok(events.some((event) => event.category === 'lecture'))
  assert.ok(events.some((event) => event.demo))
})
