import * as dagCbor from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { bytesEqual } from './memory.js'
import type { CodecAdapter } from './types.js'

function collectLinks(value: unknown, found: Map<string, CID>): void {
  const cid = CID.asCID(value)
  if (cid !== null) {
    found.set(cid.toString(), cid)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLinks(item, found)
    return
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    for (const item of Object.values(value)) collectLinks(item, found)
  }
}

export const dagCborAdapter: CodecAdapter = {
  code: dagCbor.code,
  name: dagCbor.name,
  leaf: false,
  decode: (bytes) => dagCbor.decode(bytes),
  encode: (value) => dagCbor.encode(value),
  links(value) {
    const links = new Map<string, CID>()
    collectLinks(value, links)
    return [...links.values()].sort((a, b) => a.toString().localeCompare(b.toString()))
  },
}

export const rawAdapter: CodecAdapter = {
  code: raw.code,
  name: raw.name,
  leaf: true,
  decode: (bytes) => bytes.slice(),
  encode(value) {
    if (!(value instanceof Uint8Array)) throw new TypeError('raw value must be a Uint8Array')
    return raw.encode(value)
  },
  links: () => [],
}

export class CodecRegistry {
  private readonly codecs = new Map<number, CodecAdapter>()

  constructor(codecs: readonly CodecAdapter[] = [dagCborAdapter, rawAdapter]) {
    for (const codec of codecs) {
      if (this.codecs.has(codec.code))
        throw new Error(`duplicate codec code: ${String(codec.code)}`)
      this.codecs.set(codec.code, codec)
    }
  }

  get(code: number): CodecAdapter | undefined {
    return this.codecs.get(code)
  }

  isDeterministic(codec: CodecAdapter, bytes: Uint8Array, value: unknown): boolean {
    return codec.leaf || bytesEqual(codec.encode(value), bytes)
  }
}
