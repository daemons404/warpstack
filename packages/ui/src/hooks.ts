import { useEffect, useRef, useState } from 'react'
import { Dimensions, Keyboard, Platform } from 'react-native'

/**
 * How far the software keyboard covers the bottom of the window, so a screen can keep a
 * toolbar above it. iOS reports it before the keyboard moves; Android resizes the window
 * itself (adjustResize), and the web has no keyboard to avoid, so both stay at 0.
 */
export const useKeyboardHeight = () => {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (Platform.OS !== 'ios') return
    const change = Keyboard.addListener('keyboardWillChangeFrame', e =>
      setHeight(Math.max(0, Dimensions.get('window').height - e.endCoordinates.screenY)))
    const hide = Keyboard.addListener('keyboardWillHide', () => setHeight(0))
    return () => { change.remove(); hide.remove() }
  }, [])
  return height
}

/** Pull to refresh: the spinner shows until the reload finishes, or fails and leaves the list as it was. */
export const useRefresh = (refresh: () => Promise<unknown> | void) => {
  const [refreshing, setRefreshing] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  const onRefresh = () => {
    setRefreshing(true)
    // The spinner stays until the reload is in; a failed one leaves the list as it was.
    void Promise.resolve(refresh()).catch(() => {}).finally(() => { if (mounted.current) setRefreshing(false) })
  }
  return { refreshing, onRefresh }
}
