import { useEffect, useState, useCallback } from 'react'
import { ApiError } from '../api-client.js'

export type DataState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'data'; value: T }

// Generic fetch-with-state hook (loading/error/data, DESIGN-IA.md section 4). A 401 is NOT
// surfaced as an in-page error state -- it means the session is gone, so the whole app should
// bounce to /login, which is a full navigation, not a component state.
export function useApiData<T>(fetcher: () => Promise<T>): { state: DataState<T>; reload: () => void } {
  const [state, setState] = useState<DataState<T>>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    fetcher()
      .then((value) => {
        if (!cancelled) setState({ status: 'data', value })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = '/login'
          return
        }
        setState({ status: 'error', error: err instanceof ApiError ? err : new ApiError(-1, 'unknown error') })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  return { state, reload }
}
