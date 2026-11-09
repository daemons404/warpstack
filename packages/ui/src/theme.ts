import { createContext, useContext } from 'react'
import { useColorScheme } from 'react-native'
import { palettes } from './palette.ts'

// The default theme: the palettes in palette.ts, picked by the system color scheme.

const { light, dark } = palettes
export type Colors = typeof light

/** A 4-point grid. */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const
export const radius = { sm: 6, md: 12, lg: 16, full: 999 } as const
export const type = {
  /** Cast text and most reading: 15 on 22. */
  body: { fontSize: 15, lineHeight: 22, letterSpacing: -0.04 },
  small: { fontSize: 13, lineHeight: 18 },
  name: { fontSize: 15, lineHeight: 22, fontWeight: '600' as const, letterSpacing: -0.04 },
  /** Usernames and timestamps beside a name: the name's size, lighter. */
  meta: { fontSize: 15, lineHeight: 22, letterSpacing: -0.04 },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.6 },
  title: { fontSize: 16, lineHeight: 24, fontWeight: '600' as const, letterSpacing: -0.08 },
  heading: { fontSize: 20, lineHeight: 28, fontWeight: '600' as const, letterSpacing: -0.3 },
}
/** Avatars in the feed and threads. */
export const AVATAR = 48
/** The minimum touch target, in points, for anything a finger presses. */
export const HIT = 44

export const useColors = (): Colors => (useColorScheme() === 'dark' ? dark : light)

/** Avatar backgrounds, chosen by FID so a user keeps one color. */
export const HUES = ['#7959ff', '#0e7c86', '#c2410c', '#2563eb', '#15803d', '#be185d', '#7c5c12', '#475569'] as const

/**
 * The bottom safe-area inset (the home indicator), provided by the app shell, which owns the
 * safe-area dependency. Screens that pin something to the bottom read it.
 */
export const BottomInset = createContext(0)
export const useBottomInset = () => useContext(BottomInset)
