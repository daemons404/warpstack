import { describe, expect, it } from 'vitest'
import { palettes } from './palette.ts'

// WCAG AA (1.4.3 and 1.4.11): text 4.5:1 against its background, icons and other graphics 3:1.

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('the palettes', () => {
  for (const [name, p] of Object.entries(palettes)) {
    it(`${name}: text, links and button labels meet 4.5:1, icons 3:1`, () => {
      const text: [string, string, string][] = [
        ['text', p.text, p.surface], ['muted', p.muted, p.surface], ['accent', p.accent, p.surface],
        ['danger', p.danger, p.surface], ['liked', p.liked, p.surface], ['accentText', p.accentText, p.accentFill],
        ['text on pressed', p.text, p.pressed], ['muted on field', p.muted, p.field],
      ]
      for (const [what, fg, bg] of text) expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.faint, p.surface), 'faint icons').toBeGreaterThanOrEqual(3)
    })
  }
})
