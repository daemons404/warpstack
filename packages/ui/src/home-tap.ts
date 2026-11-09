import { createContext, useContext, useEffect, useRef } from 'react'
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

// Tapping Home while home is showing, as in the Farcaster client: the feed scrolls back to the
// top, and a tap when it's already there refreshes it. The tab bar isn't a navigator's, so the
// tap reaches the list through this small signal; only lists inside Home's scope listen.

const listeners = new Set<() => void>()

/** The tab bar calls this when Home is tapped while it's already showing. */
export const tapHome = () => {
  for (const l of [...listeners]) l()
}

/** True inside Home: its lists answer the Home tab. */
export const HomeScope = createContext(false)

/** Within this many points of the top counts as at the top. */
const AT_TOP = 4

/**
 * For a list on Home: scrolls to the top on a Home tap, or refreshes when already there.
 * Spread `onScroll` and `scrollEventThrottle` onto the list and give it `ref`.
 */
export const useHomeTap = <T,>(refresh: () => void) => {
  const inHome = useContext(HomeScope)
  const ref = useRef<FlatList<T>>(null)
  const offset = useRef(0)
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    if (!inHome) return
    const onTap = () => {
      if (offset.current > AT_TOP) ref.current?.scrollToOffset({ offset: 0, animated: true })
      else latest.current()
    }
    listeners.add(onTap)
    return () => { listeners.delete(onTap) }
  }, [inHome])
  return {
    ref,
    scrollEventThrottle: 32,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => { offset.current = e.nativeEvent.contentOffset.y },
  }
}
