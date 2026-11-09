// The protobuf wire format, only as much as Farcaster messages need: varints, length-delimited
// bytes and strings, and packed repeated varints. Writes follow ts-proto's field order and
// default-omission rules exactly, so encodings match `@farcaster/core` byte for byte (the
// vectors in proto.test.ts). Snapchain hashes `data_bytes` as sent, so a matching encoding
// is a check on the builders, not a requirement of the node.

export class Writer {
  private readonly out: number[] = []

  /** Unsigned varint of a non-negative safe integer. */
  varint(n: number): this {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`varint out of range: ${n}`)
    while (n >= 0x80) {
      this.out.push((n % 0x80) | 0x80)
      n = Math.floor(n / 0x80)
    }
    this.out.push(n)
    return this
  }

  tag(field: number, wire: 0 | 2): this {
    return this.varint(field * 8 + wire)
  }

  bytes(field: number, b: Uint8Array): this {
    this.tag(field, 2).varint(b.length)
    for (const x of b) this.out.push(x)
    return this
  }

  string(field: number, s: string): this {
    return this.bytes(field, new TextEncoder().encode(s))
  }

  uint(field: number, n: number): this {
    return this.tag(field, 0).varint(n)
  }

  /** A nested message, written in full and then length-prefixed. */
  message(field: number, write: (w: Writer) => void): this {
    const inner = new Writer()
    write(inner)
    return this.bytes(field, inner.finish())
  }

  /** Packed repeated varints. ts-proto writes the field even when it's empty. */
  packed(field: number, values: readonly number[]): this {
    const inner = new Writer()
    for (const v of values) inner.varint(v)
    return this.bytes(field, inner.finish())
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

export type Field = { field: number; wire: 0; value: number } | { field: number; wire: 2; value: Uint8Array }

/**
 * Reads the top-level fields of a message. Throws on anything malformed, including wire
 * types this format never uses and varints past 2^53; callers catch and refuse.
 */
export const readFields = (b: Uint8Array): Field[] => {
  const fields: Field[] = []
  let i = 0
  const varint = (): number => {
    let n = 0
    let mul = 1
    for (let shift = 0; shift < 64; shift += 7) {
      if (i >= b.length) throw new Error('truncated varint')
      const x = b[i++] as number
      n += (x & 0x7f) * mul
      if (!Number.isSafeInteger(n)) throw new Error('varint too large')
      if (x < 0x80) return n
      mul *= 0x80
    }
    throw new Error('varint too long')
  }
  while (i < b.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (field < 1) throw new Error('bad field number')
    if (wire === 0) fields.push({ field, wire, value: varint() })
    else if (wire === 2) {
      const len = varint()
      if (i + len > b.length) throw new Error('truncated bytes')
      fields.push({ field, wire, value: b.subarray(i, i + len) })
      i += len
    } else throw new Error(`unsupported wire type ${wire}`)
  }
  return fields
}
