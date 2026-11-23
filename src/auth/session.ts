// Demo session storage. The backend JWT and any pending registration live in
// sessionStorage so a refresh keeps them while closing the tab ends them.
// Passwords and verification codes are never stored.

const tokenKey = 'serviceunsw-auth-token'
const pendingKey = 'serviceunsw-pending-registration'

export interface PendingRegistration {
  zId: string
  registrationToken: string
  /** When the most recent code was sent (ms since epoch), for the resend cooldown. */
  sentAt: number
}

export function readSessionToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.sessionStorage.getItem(tokenKey)
}

export function saveSessionToken(token: string): void {
  window.sessionStorage.setItem(tokenKey, token)
}

export function clearSession(): void {
  window.sessionStorage.removeItem(tokenKey)
}

export function readPendingRegistration(): PendingRegistration | null {
  if (typeof window === 'undefined') return null
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(pendingKey) ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const { zId, registrationToken, sentAt } = value as Record<string, unknown>
    if (typeof zId !== 'string' || typeof registrationToken !== 'string' || typeof sentAt !== 'number') return null
    return { zId, registrationToken, sentAt }
  } catch {
    return null
  }
}

export function savePendingRegistration(pending: PendingRegistration): void {
  window.sessionStorage.setItem(pendingKey, JSON.stringify(pending))
}

export function clearPendingRegistration(): void {
  window.sessionStorage.removeItem(pendingKey)
}
