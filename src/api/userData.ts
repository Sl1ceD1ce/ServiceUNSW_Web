// Portal records saved in the backend's per-account key-value store
// (`/v1/users/me/data`, JWT bearer).
//
// The backend keeps each value in a VARCHAR(191) column, which most records
// outgrow. A record is therefore stored as a header key plus chunk keys:
//
//   portal.<name>        {"v": <value>}   when the whole record fits, or
//                        {"chunks": n}    with the JSON text split across
//   portal.<name>#0..n-1 "<part of the JSON text>"
//
// Every key of one record is written in a single PATCH, which the backend
// applies in one transaction, so readers never see half a record. Chunks left
// over from a longer earlier version are ignored and deleted best-effort.

import { BackendError, deleteUserData, fetchUserData, patchUserData } from './backend'
import { readSessionToken } from '../auth/session'

const KEY_PREFIX = 'portal.'
/** Stays under VARCHAR(191) with room to spare; counted in UTF-16 units, which is never fewer than MySQL's characters. */
const MAX_STORED_CHARS = 180
/** Express's default JSON body limit is 100 kB. */
const MAX_REQUEST_CHARS = 90_000

let cache: { token: string; data: Promise<Record<string, unknown>> } | undefined
let writeQueue: Promise<unknown> = Promise.resolve()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function currentToken(): string {
  const token = readSessionToken()
  if (!token) throw new BackendError(401, 'Your session has ended. Please sign in again.')
  return token
}

/** All saved keys for the signed-in account, fetched once per session token. */
function savedData(): Promise<Record<string, unknown>> {
  const token = currentToken()
  if (cache?.token !== token) {
    const data = fetchUserData(token)
    cache = { token, data }
    data.catch(() => {
      if (cache?.data === data) cache = undefined
    })
  }
  return cache.data
}

function chunkCount(header: unknown): number {
  return isRecord(header) && typeof header.chunks === 'number' && Number.isInteger(header.chunks) && header.chunks > 0
    ? header.chunks
    : 0
}

function decode(data: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(data, key)) return undefined
  const header = data[key]
  if (isRecord(header) && Object.hasOwn(header, 'v')) return header.v
  const count = chunkCount(header)
  if (count === 0) throw new Error(`Saved data for ${key} is invalid.`)
  let text = ''
  for (let index = 0; index < count; index += 1) {
    const chunk = data[`${key}#${index}`]
    if (typeof chunk !== 'string') throw new Error(`Saved data for ${key} is incomplete.`)
    text += chunk
  }
  return JSON.parse(text)
}

/** Splits text so each piece, once JSON-encoded, fits in one stored value. Never splits a surrogate pair. */
function splitForStorage(text: string): string[] {
  const chunks: string[] = []
  let current = ''
  let currentSize = 2 // the surrounding quotes
  for (const character of text) {
    const size = JSON.stringify(character).length - 2
    if (currentSize + size > MAX_STORED_CHARS) {
      chunks.push(current)
      current = ''
      currentSize = 2
    }
    current += character
    currentSize += size
  }
  if (current || chunks.length === 0) chunks.push(current)
  return chunks
}

function encode(key: string, value: unknown): Record<string, unknown> {
  const inline = { v: value }
  if (JSON.stringify(inline).length <= MAX_STORED_CHARS) return { [key]: inline }
  const chunks = splitForStorage(JSON.stringify(value))
  return Object.fromEntries([
    [key, { chunks: chunks.length }],
    ...chunks.map((chunk, index) => [`${key}#${index}`, chunk]),
  ])
}

/** Returns the saved record, or `undefined` if this account has never saved it. */
export async function readRecord(name: string): Promise<unknown> {
  return decode(await savedData(), KEY_PREFIX + name)
}

/** Saves the record. Writes run one at a time so a record's chunks are never interleaved. */
export function writeRecord(name: string, value: unknown): Promise<void> {
  const operation = writeQueue.then(async () => {
    const token = currentToken()
    const data = await savedData()
    const key = KEY_PREFIX + name
    const entries = encode(key, value)
    if (JSON.stringify(entries).length > MAX_REQUEST_CHARS) {
      throw new Error('This is too much to save at once. Remove some items and try again.')
    }
    await patchUserData(token, entries)

    const previousCount = chunkCount(data[key])
    const nextCount = chunkCount(entries[key])
    Object.assign(data, entries)
    const stale: string[] = []
    for (let index = nextCount; index < previousCount; index += 1) {
      stale.push(`${key}#${index}`)
      delete data[`${key}#${index}`]
    }
    // Awaited inside the queue so a late delete can't remove a chunk that the
    // next write has just recreated. A failure only leaves an unread chunk.
    await Promise.all(stale.map((staleKey) => deleteUserData(token, staleKey).catch((error: unknown) => {
      console.warn(`Unable to delete unused saved data ${staleKey}:`, error)
    })))
  })
  writeQueue = operation.catch(() => undefined)
  return operation
}
