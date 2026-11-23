// Client for the ServiceUNSW backend (`/v1`), which owns accounts, sign-in,
// email verification and each account's saved portal data.
//
// Hosted (S3 + CloudFront, see ServiceUNSW-infra): the publisher writes
// `/runtime-config.json` with `apiBaseUrl`, and requests go straight to API
// Gateway with a bearer token. Local dev: that file is absent, so requests use
// same-origin `/v1`, which Vite proxies to `SERVICEUNSW_API_URL`.

export class BackendError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface BackendUser {
  zId: string
  firstName: string
  lastName: string
  /** Unix timestamp in milliseconds. */
  dateOfBirth: number
  degree: string
}

export interface RegistrationDetails extends BackendUser {
  password: string
}

let apiBase: Promise<string> | undefined

function resolveApiBase(): Promise<string> {
  apiBase ??= fetch('/runtime-config.json', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) return '/v1'
      const config: unknown = await response.json()
      if (!isRecord(config) || typeof config.apiBaseUrl !== 'string' || !config.apiBaseUrl) return '/v1'
      return `${config.apiBaseUrl.replace(/\/+$/, '')}/v1`
    })
    .catch(() => '/v1')
  return apiBase
}

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<unknown> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (init.token) headers.Authorization = `Bearer ${init.token}`

  let response: Response
  try {
    response = await fetch(`${await resolveApiBase()}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    })
  } catch {
    throw new BackendError(0, 'Unable to reach the ServiceUNSW service. Check your connection and try again.')
  }

  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : fallbackMessage(response.status)
    throw new BackendError(response.status, message)
  }
  return body
}

function fallbackMessage(status: number): string {
  if (status === 429) return 'Too many requests. Please wait a moment and try again.'
  if (status === 502 || status === 504) return 'Unable to reach the ServiceUNSW service. Please try again.'
  if (status >= 500) return 'The ServiceUNSW service is unavailable. Please try again later.'
  return `Request failed (${status}).`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readToken(value: unknown): string {
  if (!isRecord(value) || typeof value.token !== 'string' || !value.token) {
    throw new BackendError(500, 'The ServiceUNSW service returned an invalid sign-in response.')
  }
  return value.token
}

/** Returns a JWT. Throws 401 for wrong credentials and 403 for unverified accounts. */
export async function login(zId: string, password: string): Promise<string> {
  return readToken(await call('/auth/login', { body: { zId, password } }))
}

/** Starts a pending registration; SES emails a six-digit code to `${zId}@ad.unsw.edu.au`. */
export async function register(details: RegistrationDetails): Promise<string> {
  const value = await call('/auth/register', { body: details })
  if (!isRecord(value) || typeof value.registrationToken !== 'string') {
    throw new BackendError(500, 'The ServiceUNSW service returned an invalid registration response.')
  }
  return value.registrationToken
}

/** Consumes the emailed code and returns a JWT for the now-verified account. */
export async function verifyRegistration(zId: string, registrationToken: string, verificationCode: number): Promise<string> {
  return readToken(await call('/auth/register/verify', { body: { zId, registrationToken, verificationCode } }))
}

/** Emails a replacement code; the previous code stops working. */
export async function resendVerification(zId: string, registrationToken: string): Promise<void> {
  await call('/auth/register/resend', { body: { zId, registrationToken } })
}

export async function fetchMe(token: string): Promise<BackendUser> {
  const value = await call('/users/me', { token })
  if (!isRecord(value) || typeof value.zId !== 'string' || typeof value.firstName !== 'string' ||
    typeof value.lastName !== 'string' || typeof value.degree !== 'string' || typeof value.dateOfBirth !== 'number') {
    throw new BackendError(500, 'The ServiceUNSW service returned invalid account details.')
  }
  return value as unknown as BackendUser
}

/**
 * Fetches an iCal feed through the backend's `/calendar/ics` proxy, which
 * blocks private addresses and only returns iCalendar content.
 */
export async function fetchCalendarFeed(token: string, url: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${await resolveApiBase()}/calendar/ics?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
  } catch {
    throw new BackendError(0, 'Unable to reach the ServiceUNSW service. Check your connection and try again.')
  }
  if (response.ok) return response.text()
  const body: unknown = await response.json().catch(() => null)
  // The backend hides 5xx details, so name the likely cause here.
  const message = response.status >= 500
    ? 'The calendar server could not be reached or took too long. Try again later.'
    : isRecord(body) && typeof body.error === 'string' ? body.error : fallbackMessage(response.status)
  throw new BackendError(response.status, message)
}

// Per-account key-value store (`/v1/users/me/data`). Values are any JSON; the
// backend stores each as a string column, so see userData.ts for size limits.

/** Returns every stored key for the signed-in account. */
export async function fetchUserData(token: string): Promise<Record<string, unknown>> {
  const value = await call('/users/me/data', { token })
  if (!isRecord(value)) throw new BackendError(500, 'The ServiceUNSW service returned invalid saved data.')
  return value
}

/** Creates or replaces the given keys in one transaction. */
export async function patchUserData(token: string, values: Record<string, unknown>): Promise<void> {
  await call('/users/me/data', { method: 'PATCH', body: values, token })
}

/** Deletes one key; a key that is already gone is not an error. */
export async function deleteUserData(token: string, key: string): Promise<void> {
  try {
    await call(`/users/me/data?key=${encodeURIComponent(key)}`, { method: 'DELETE', token })
  } catch (error) {
    if (!(error instanceof BackendError && error.status === 404)) throw error
  }
}

export const PASSWORD_RULES: { test: (password: string) => boolean; label: string }[] = [
  { test: (password) => password.length >= 14, label: 'At least 14 characters' },
  { test: (password) => /[A-Z]/.test(password), label: 'An uppercase letter' },
  { test: (password) => /[a-z]/.test(password), label: 'A lowercase letter' },
  { test: (password) => /[0-9]/.test(password), label: 'A number' },
]
