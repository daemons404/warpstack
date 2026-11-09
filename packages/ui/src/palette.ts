// The default palettes: platform-neutral tokens. The palette,
// spacing and type scale follow the Farcaster client's design system (farcasterxyz/client,
// packages/farcaster-expo/src/theme, MIT), so a Warpstack app feels familiar; values only, no
// code. `muted` is its secondary text, `faint` its tertiary: icons only, never text.
//
// Each pair meets WCAG AA (palette.test.ts checks it): text 4.5:1 on its background, icons
// 3:1. Where the Farcaster palette fell short, the color moved just far enough: light
// `accent` and `faint`, and dark `accentFill` (buttons) and `liked`.
const light = {
  bg: '#ffffff', surface: '#ffffff', text: '#121212', muted: '#6a6a6a', faint: '#8a8a8a', border: '#ececed',
  accent: '#7454fb', accentFill: '#7454fb', accentText: '#ffffff', danger: '#d92d20', liked: '#d51338', pressed: '#f5f5f5', field: '#f2f2f2',
}
const dark: typeof light = {
  bg: '#101010', surface: '#101010', text: '#ffffff', muted: '#a5a5a5', faint: '#6a6a6a', border: '#24292e',
  accent: '#866aff', accentFill: '#7556e8', accentText: '#ffffff', danger: '#f97066', liked: '#f0446a', pressed: '#1e1e1e', field: '#1e1e1e',
}
/** The palettes; palette.test.ts checks their contrast. */
export const palettes = { light, dark } as const
