import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { BackendError, fetchMe } from './api/backend'
import { linkProfile } from './api/portalData'
import { clearSession, readSessionToken, saveSessionToken } from './auth/session'
import type { User } from './models/users'
import { useCalendarData } from './calendar/useCalendarData'
import { useFavourites } from './hooks/useFavourites'
import { useServices } from './hooks/useServices'
import Sidebar from './components/Sidebar'
import Calendar from './pages/Calendar'
import Home from './pages/Home'
import Lectures from './pages/Lectures'
import Castle from './pages/Castle'
import Timesheets from './pages/Timesheets'
import Profile from './pages/Profile'
import QuickLinks from './pages/QuickLinks'
import SignIn from './pages/SignIn'
import './App.css'

/** Loads the backend account for a JWT, then the matching portal profile. */
async function loadUser(token: string): Promise<User> {
  return linkProfile(await fetchMe(token))
}

function App() {
  const navigate = useNavigate()
  const [session, setSession] = useState<{ user: User | null; restoring: boolean; error: string }>(() => {
    try {
      return { user: null, restoring: readSessionToken() !== null, error: '' }
    } catch (error) {
      console.error('Unable to restore session:', error)
      return { user: null, restoring: false, error: 'Unable to restore your session. Please allow browser session storage and sign in again.' }
    }
  })

  useEffect(() => {
    if (!session.restoring) return
    let cancelled = false
    const token = readSessionToken()
    if (!token) return
    loadUser(token)
      .then((user) => {
        if (!cancelled) setSession({ user, restoring: false, error: '' })
      })
      .catch((error: unknown) => {
        console.error('Unable to restore session:', error)
        if (cancelled) return
        const expired = error instanceof BackendError && (error.status === 401 || error.status === 403 || error.status === 404)
        if (expired) {
          try { clearSession() } catch { /* sign-in will overwrite the stale token */ }
        }
        setSession({
          user: null,
          restoring: false,
          error: expired ? 'Your session has ended. Please sign in again.' : 'Unable to restore your session. Please sign in again.',
        })
      })
    return () => { cancelled = true }
  }, [session.restoring])

  // Called by the sign-in page with a JWT from login or email verification.
  // Throws so the sign-in page can show what went wrong.
  async function authenticate(token: string): Promise<void> {
    const user = await loadUser(token)
    saveSessionToken(token)
    setSession({ user, restoring: false, error: '' })
    navigate('/home', { replace: true })
  }

  function signOut() {
    let message = ''
    try {
      clearSession()
    } catch (error) {
      console.error('Unable to clear session:', error)
      message = 'Browser session storage could not be cleared. Close this tab to fully end your session.'
    }
    setSession({ user: null, restoring: false, error: message })
    navigate('/sign-in', { replace: true })
  }

  const user = session.user
  if (session.restoring) {
    return <p className="app-loading" role="status">Restoring your session…</p>
  }
  if (!user) {
    return (
      <Routes>
        <Route path="/sign-in" element={<SignIn onAuthenticated={authenticate} sessionError={session.error} />} />
        <Route path="*" element={<Navigate to="/sign-in" replace />} />
      </Routes>
    )
  }

  return <Portal key={user.id} user={user} onSignOut={signOut} />
}

function Portal({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const calendar = useCalendarData(user)
  const favourites = useFavourites(user.id)
  const catalogue = useServices(user)
  return (
    <div className="app-layout">
      <Sidebar user={user} />
      <main className="app-content">
        <Routes>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<Home user={user} calendar={calendar} favourites={favourites} catalogue={catalogue} />} />
          <Route path="/calendar" element={<Calendar calendar={calendar} />} />
          <Route path="/quick-links" element={<QuickLinks favourites={favourites} catalogue={catalogue} />} />
          <Route
            path="/lectures"
            element={user.roles.includes('professor') ? <Lectures user={user} /> : <Navigate to="/home" replace />}
          />
          <Route
            path="/timesheets"
            element={user.roles.includes('tutor') ? <Timesheets user={user} /> : <Navigate to="/home" replace />}
          />
          <Route
            path="/castle"
            element={user.roles.includes('tutor') ? <Castle user={user} /> : <Navigate to="/home" replace />}
          />
          <Route path="/profile" element={<Profile user={user} onSignOut={onSignOut} />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
