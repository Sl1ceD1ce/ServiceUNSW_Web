import { useMemo } from 'react'
import { getServiceCatalogue } from '../api/portalData'
import type { ServiceCatalogue } from '../models/services'
import type { User } from '../models/users'

/** The service catalogue is bundled with the app, so it is ready immediately. */
export function useServices(user: User): ServiceCatalogue & { loading: boolean; error: string } {
  return useMemo(() => ({ ...getServiceCatalogue(user), loading: false, error: '' }), [user])
}

export type ServicesState = ReturnType<typeof useServices>
