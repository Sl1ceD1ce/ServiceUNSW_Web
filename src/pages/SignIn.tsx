import { useEffect, useState } from 'react'
import type { SubmitEvent } from 'react'
import {
  BackendError, PASSWORD_RULES, login, register, resendVerification, verifyRegistration,
} from '../api/backend'
import {
  clearPendingRegistration, readPendingRegistration, savePendingRegistration,
} from '../auth/session'
import type { PendingRegistration } from '../auth/session'
import myunswLogo from '../assets/myunsw.png'
import './SignIn.css'

type View = 'sign-in' | 'register' | 'verify'

const RESEND_COOLDOWN_MS = 60_000
const ZID_PATTERN = '[zZ][0-9]{7}'

function studentEmail(zId: string): string {
  return `${zId}@ad.unsw.edu.au`
}

/** Turns a backend error into a sentence for the form. */
function describeError(error: unknown, fallback: string): string {
  if (error instanceof BackendError) {
    if (error.status === 0 || error.status >= 500) {
      return error.status === 503
        ? 'The verification email could not be sent. Please try again shortly.'
        : error.message
    }
    return error.message.replace(/^Invalid input data:\s*/, '')
  }
  return fallback
}

function readStoredPending(): PendingRegistration | null {
  try { return readPendingRegistration() } catch { return null }
}

function SignIn({ onAuthenticated, sessionError }: {
  onAuthenticated: (token: string) => Promise<void>
  sessionError: string
}) {
  const [pending, setPending] = useState<PendingRegistration | null>(readStoredPending)
  const [view, setView] = useState<View>(() => (pending ? 'verify' : 'sign-in'))
  const [notice, setNotice] = useState('')
  const [unverifiedZid, setUnverifiedZid] = useState('')

  function show(next: View, message = '') {
    setNotice(message)
    setUnverifiedZid('')
    setView(next)
  }

  function startVerification(next: PendingRegistration) {
    try {
      savePendingRegistration(next)
    } catch (error) {
      // Still usable for this page view; a refresh would lose it.
      console.error('Unable to store pending registration:', error)
    }
    setPending(next)
    show('verify')
  }

  function abandonVerification() {
    try { clearPendingRegistration() } catch { /* nothing to clear */ }
    setPending(null)
    show('register')
  }

  async function finish(token: string) {
    try { clearPendingRegistration() } catch { /* verified; stale token is harmless */ }
    try {
      await onAuthenticated(token)
    } catch (error) {
      console.error('Unable to start session:', error)
      setPending(null)
      show('sign-in', error instanceof BackendError
        ? 'Your account is ready, but your workspace could not be loaded. Please sign in.'
        : 'Your account is ready, but your workspace could not be loaded. Please allow browser session storage and sign in.')
    }
  }

  return (
    <main className="sign-in-page">
      <section className="sign-in-card" aria-labelledby="sign-in-title">
        <div className="sign-in-brand">
          <img src={myunswLogo} alt="UNSW crest" />
          <span>ServiceUNSW</span>
        </div>

        {view === 'sign-in' && (
          <SignInForm
            notice={notice || sessionError}
            unverifiedZid={unverifiedZid}
            pending={pending}
            onUnverified={(zId) => {
              if (pending?.zId === zId) {
                show('verify', 'Your account still needs email verification. Enter the code we sent you.')
              } else {
                setUnverifiedZid(zId)
              }
            }}
            onToken={finish}
            onRegister={() => show('register')}
            onVerify={() => show('verify')}
          />
        )}

        {view === 'register' && (
          <RegisterForm
            onRegistered={startVerification}
            onSignIn={() => show('sign-in')}
          />
        )}

        {view === 'verify' && pending && (
          <VerifyForm
            pending={pending}
            notice={notice}
            onResent={startVerification}
            onToken={finish}
            onRestart={abandonVerification}
          />
        )}

        <p className="sign-in-demo">
          Demonstration only. Your password and verification code go to the ServiceUNSW
          service, which is not connected to UNSW identity. Do not reuse your real zPass.
        </p>
      </section>
    </main>
  )
}

function SignInForm({ notice, unverifiedZid, pending, onUnverified, onToken, onRegister, onVerify }: {
  notice: string
  unverifiedZid: string
  pending: PendingRegistration | null
  onUnverified: (zId: string) => void
  onToken: (token: string) => Promise<void>
  onRegister: () => void
  onVerify: () => void
}) {
  const [zid, setZid] = useState(pending?.zId ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const zId = zid.trim().toLowerCase()
    setError('')
    setSubmitting(true)
    try {
      const token = await login(zId, password)
      await onToken(token)
    } catch (signInError) {
      console.error('Unable to sign in:', signInError)
      setPassword('')
      setSubmitting(false)
      if (signInError instanceof BackendError && signInError.status === 403) {
        onUnverified(zId)
        return
      }
      setError(signInError instanceof BackendError && signInError.status === 401
        ? 'Incorrect zID or password. Please try again.'
        : describeError(signInError, 'Unable to sign in. Please try again.'))
    }
  }

  const message = error || (unverifiedZid
    ? `${unverifiedZid} hasn't been verified yet. Register again with the same zID to get a new code.`
    : notice)

  return (
    <>
      <h1 id="sign-in-title">Sign in</h1>
      <p>Access your university workspace with your zID and password.</p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="zid">zID</label>
        <input
          id="zid"
          name="zid"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          pattern={ZID_PATTERN}
          title="Enter z followed by seven digits."
          value={zid}
          onChange={(event) => setZid(event.target.value)}
          required
          aria-describedby={message ? 'sign-in-error' : undefined}
          aria-invalid={!!error}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          aria-describedby={message ? 'sign-in-error' : undefined}
          aria-invalid={!!error}
        />
        {message && (
          <p id="sign-in-error" className={error || unverifiedZid ? 'sign-in-error' : 'sign-in-notice'} role="alert">
            {message}
          </p>
        )}
        <button type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div className="sign-in-switch">
        {pending && (
          <p>
            Waiting on a code for {pending.zId}?{' '}
            <button type="button" className="sign-in-link" onClick={onVerify}>Enter code</button>
          </p>
        )}
        <p>
          New to ServiceUNSW?{' '}
          <button type="button" className="sign-in-link" onClick={onRegister}>Create an account</button>
        </p>
      </div>
    </>
  )
}

function RegisterForm({ onRegistered, onSignIn }: {
  onRegistered: (pending: PendingRegistration) => void
  onSignIn: () => void
}) {
  const [form, setForm] = useState({
    zId: '', firstName: '', lastName: '', dateOfBirth: '', degree: '', password: '', confirm: '',
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const today = new Date().toISOString().slice(0, 10)

  function update(field: keyof typeof form) {
    return (event: { target: { value: string } }) => setForm((current) => ({ ...current, [field]: event.target.value }))
  }

  const unmetRules = PASSWORD_RULES.filter((rule) => !rule.test(form.password))
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (unmetRules.length > 0) {
      setError('Your password does not meet every requirement below.')
      return
    }
    if (form.password !== form.confirm) {
      setError('The passwords do not match.')
      return
    }
    const [year, month, day] = form.dateOfBirth.split('-').map(Number)
    const zId = form.zId.trim().toLowerCase()
    setSubmitting(true)
    try {
      const registrationToken = await register({
        zId,
        password: form.password,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        dateOfBirth: Date.UTC(year, month - 1, day),
        degree: form.degree.trim(),
      })
      onRegistered({ zId, registrationToken, sentAt: Date.now() })
    } catch (registerError) {
      console.error('Unable to register:', registerError)
      setError(describeError(registerError, 'Unable to create your account. Please try again.'))
      setSubmitting(false)
    }
  }

  const describedBy = error ? 'register-error' : undefined

  return (
    <>
      <h1 id="sign-in-title">Create an account</h1>
      <p>We'll email a verification code to your student address.</p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="reg-zid">zID</label>
        <input
          id="reg-zid"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          pattern={ZID_PATTERN}
          title="Enter z followed by seven digits."
          value={form.zId}
          onChange={update('zId')}
          required
          aria-describedby={describedBy}
        />
        <div className="sign-in-row">
          <div>
            <label htmlFor="reg-first">First name</label>
            <input id="reg-first" autoComplete="given-name" value={form.firstName} onChange={update('firstName')}
              pattern="[A-Za-z\s\-]+" title="Letters, spaces and hyphens only." required />
          </div>
          <div>
            <label htmlFor="reg-last">Last name</label>
            <input id="reg-last" autoComplete="family-name" value={form.lastName} onChange={update('lastName')}
              pattern="[A-Za-z\s\-]+" title="Letters, spaces and hyphens only." required />
          </div>
        </div>
        <label htmlFor="reg-dob">Date of birth</label>
        <input id="reg-dob" type="date" autoComplete="bday" max={today} value={form.dateOfBirth}
          onChange={update('dateOfBirth')} required />
        <label htmlFor="reg-degree">Degree</label>
        <input id="reg-degree" placeholder="Bachelor of Computer Science" maxLength={191}
          value={form.degree} onChange={update('degree')} required />
        <label htmlFor="reg-password">Password</label>
        <input id="reg-password" type="password" autoComplete="new-password" value={form.password}
          onChange={update('password')} required aria-describedby="password-rules" />
        <ul id="password-rules" className="sign-in-rules" aria-label="Password requirements">
          {PASSWORD_RULES.map((rule) => {
            const met = rule.test(form.password)
            return (
              <li key={rule.label} className={met ? 'met' : undefined}>
                <span aria-hidden="true">{met ? '✓' : '•'}</span> {rule.label}
                <span className="visually-hidden">{met ? ' (met)' : ' (not met)'}</span>
              </li>
            )
          })}
        </ul>
        <label htmlFor="reg-confirm">Confirm password</label>
        <input id="reg-confirm" type="password" autoComplete="new-password" value={form.confirm}
          onChange={update('confirm')} required aria-invalid={mismatch} />
        {mismatch && !error && <p className="sign-in-error">The passwords do not match.</p>}
        {error && <p id="register-error" className="sign-in-error" role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>{submitting ? 'Sending code…' : 'Create account'}</button>
      </form>
      <div className="sign-in-switch">
        <p>
          Already registered?{' '}
          <button type="button" className="sign-in-link" onClick={onSignIn}>Sign in</button>
        </p>
      </div>
    </>
  )
}

function VerifyForm({ pending, notice, onResent, onToken, onRestart }: {
  pending: PendingRegistration
  notice: string
  onResent: (pending: PendingRegistration) => void
  onToken: (token: string) => Promise<void>
  onRestart: () => void
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState(notice)
  const [submitting, setSubmitting] = useState(false)
  const [resending, setResending] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const cooldown = Math.max(0, Math.ceil((pending.sentAt + RESEND_COOLDOWN_MS - now) / 1000))
  useEffect(() => {
    if (cooldown === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setStatus('')
    setSubmitting(true)
    try {
      const token = await verifyRegistration(pending.zId, pending.registrationToken, Number(code))
      await onToken(token)
    } catch (verifyError) {
      console.error('Unable to verify:', verifyError)
      setCode('')
      setSubmitting(false)
      setError(verifyError instanceof BackendError && verifyError.status === 401
        ? 'That code is incorrect or has expired. Check your email, or send a new code.'
        : describeError(verifyError, 'Unable to verify your code. Please try again.'))
    }
  }

  async function handleResend() {
    setError('')
    setStatus('')
    setResending(true)
    try {
      await resendVerification(pending.zId, pending.registrationToken)
      setCode('')
      onResent({ ...pending, sentAt: Date.now() })
      setNow(Date.now())
      setStatus('A new code is on its way. Earlier codes no longer work.')
    } catch (resendError) {
      console.error('Unable to resend code:', resendError)
      setError(describeError(resendError, 'Unable to send a new code. Please try again.'))
    } finally {
      setResending(false)
    }
  }

  return (
    <>
      <h1 id="sign-in-title">Verify your email</h1>
      <p>
        Enter the six-digit code sent to <strong>{studentEmail(pending.zId)}</strong>.
        Codes expire after 10 minutes.
      </p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="verify-code">Verification code</label>
        <input
          id="verify-code"
          className="sign-in-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          title="Enter the six-digit code."
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          required
          autoFocus
          aria-describedby={error || status ? 'verify-message' : undefined}
          aria-invalid={!!error}
        />
        {(error || status) && (
          <p id="verify-message" className={error ? 'sign-in-error' : 'sign-in-notice'} role={error ? 'alert' : 'status'}>
            {error || status}
          </p>
        )}
        <button type="submit" disabled={submitting || code.length !== 6}>
          {submitting ? 'Verifying…' : 'Verify and continue'}
        </button>
        <button type="button" className="sign-in-secondary" onClick={handleResend}
          disabled={resending || cooldown > 0}>
          {resending ? 'Sending…' : cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
        </button>
      </form>
      <div className="sign-in-switch">
        <p>
          Wrong zID?{' '}
          <button type="button" className="sign-in-link" onClick={onRestart}>Start again</button>
        </p>
      </div>
    </>
  )
}

export default SignIn
