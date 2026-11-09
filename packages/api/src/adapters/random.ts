import type { Random } from '../ports.ts'

export const systemRandom: Random = {
  bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
}
