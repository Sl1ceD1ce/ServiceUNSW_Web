import { useMemo } from 'react'
import { getLecturePlan } from '../api/portalData'
import type { LecturePlan } from '../models/lectures'
import type { User } from '../models/users'

/** The lecture schedule is bundled with the app, so it is ready immediately. */
export function useLecturePlan(user: User): LecturePlan & { loading: boolean; error: string } {
  return useMemo(() => {
    try {
      return { ...getLecturePlan(user), loading: false, error: '' }
    } catch (error) {
      console.error('Unable to load lecture plan:', error)
      return { courses: [], sessions: [], loading: false, error: 'Unable to load your lecture plan. Refresh the page and try again.' }
    }
  }, [user])
}
