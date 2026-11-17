/*
 * qrcodegen.js — QR Code Model 2 encoder (byte mode, error-correction level M).
 *
 * This file is an independent, dependency-free implementation of ISO/IEC 18004
 * written for the DSH Pair plugin. It exposes the same small surface the Pair
 * host code and its tests expect (`encodeQr` -> boolean module matrix) and
 * follows the public API shape of Nayuki's QR Code generator library.
 *
 * It is NOT a copy of Nayuki's code: the upstream repository could not be
 * fetched in the build environment (offline). See VENDORED.md beside this file
 * for provenance and the exact adaptation. The implementation was validated
 * structurally and byte-for-byte against an independent local QR encoder
 * (Kazuhiko Arase's QRCode.js, MIT, shipped with npm's qrcode-terminal) during
 * development; no code was copied from it.
 *
 * License: MIT (see qrcodegen.LICENSE.txt in this directory).
 *
 * SPDX-License-Identifier: MIT
 */

/** Number of error-correction codewords per block for level M, version 1..40. */
const ECC_CODEWORDS_PER_BLOCK_M = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
  30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
]

/** Number of error-correction blocks for level M, version 1..40. */
const NUM_ERROR_CORRECTION_BLOCKS_M = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
  5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
  31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
]

/** Error-correction level M's two-bit format value. */
const ECC_FORMAT_BITS_M = 0

/** Maximum QR symbol version (1..40). */
export const MAX_VERSION = 40

/** Maximum input accepted by the byte-mode encoder, in bytes (version 40-M). */
export const MAX_BYTE_LENGTH = 2331

/**
 * Thrown when the input cannot be represented in a QR symbol at level M.
 * The caller (`pair/host/qr.js`) maps this to the public `QR_*` error codes.
 */
export class QrEncodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QrEncodeError'
  }
}

// ---------------------------------------------------------------------------
// Reed-Solomon arithmetic over GF(2^8), primitive polynomial 0x11D.
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let value = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value
    GF_LOG[value] = i
    value <<= 1
    if ((value & 0x100) !== 0) value ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]
}

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** Generator polynomial coefficients (highest degree first) for `degree` ECC bytes. */
function reedSolomonDivisor(degree) {
  let result = Uint8Array.of(1)
  for (let i = 0; i < degree; i += 1) {
    const root = GF_EXP[i]
    const next = new Uint8Array(result.length + 1)
    for (let j = 0; j < result.length; j += 1) {
      next[j] ^= result[j]
      next[j + 1] ^= gfMultiply(result[j], root)
    }
    result = next
  }
  return result
}

/** Remainder of the data polynomial divided by the generator polynomial. */
function reedSolomonRemainder(data, divisor) {
  const remainder = new Uint8Array(divisor.length - 1)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[remainder.length - 1] = 0
    for (let i = 0; i < remainder.length; i += 1) {
      remainder[i] ^= gfMultiply(divisor[i + 1], factor)
    }
  }
  return remainder
}

// ---------------------------------------------------------------------------
// Capacity tables computed from the symbol geometry.
// ---------------------------------------------------------------------------

/** Number of data+ECC modules available for codewords in a version. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

function dataCodewords(version) {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK_M[version - 1] * NUM_ERROR_CORRECTION_BLOCKS_M[version - 1]
  )
}

function characterCountBits(version) {
  return version <= 9 ? 8 : 16
}

/** Smallest version whose level-M data capacity fits mode + count + payload. */
function chooseVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const capacityBits = dataCodewords(version) * 8
    const requiredBits = 4 + characterCountBits(version) + byteLength * 8
    if (requiredBits <= capacityBits) return version
  }
  throw new QrEncodeError(
    `the input is too long for a QR code: ${byteLength} bytes exceed the ${MAX_BYTE_LENGTH}-byte version 40-M limit`,
  )
}

// ---------------------------------------------------------------------------
// Bit buffer.
// ---------------------------------------------------------------------------

class BitBuffer {
  constructor() {
    this.bits = []
  }

  append(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push(((value >>> i) & 1) !== 0)
  }
}

/** Builds the padded data codeword stream for one version from UTF-8 bytes. */
function buildDataCodewords(bytes, version) {
  const capacityBits = dataCodewords(version) * 8
  const buffer = new BitBuffer()
  buffer.append(0b0100, 4) // byte mode
  buffer.append(bytes.length, characterCountBits(version))
  for (const byte of bytes) buffer.append(byte, 8)

  const terminator = Math.min(4, capacityBits - buffer.bits.length)
  buffer.append(0, terminator)
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(false)

  const result = []
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (buffer.bits[i + j] ? 1 : 0)
    result.push(byte)
  }
  const padBytes = [0xec, 0x11]
  for (let i = 0; result.length * 8 < capacityBits; i += 1) result.push(padBytes[i % 2])
  return Uint8Array.from(result)
}

// ---------------------------------------------------------------------------
// Symbol construction.
// ---------------------------------------------------------------------------

class QrSymbol {
  constructor(version) {
    this.version = version
    this.size = version * 4 + 17
    this.modules = []
    this.isFunction = []
    for (let y = 0; y < this.size; y += 1) {
      this.modules.push(new Array(this.size).fill(false))
      this.isFunction.push(new Array(this.size).fill(false))
    }
  }

  setFunction(x, y, dark) {
    this.modules[y][x] = dark
    this.isFunction[y][x] = true
  }

  drawFunctionPatterns() {
    const size = this.size
    // Timing patterns.
    for (let i = 0; i < size; i += 1) {
      this.setFunction(6, i, i % 2 === 0)
      this.setFunction(i, 6, i % 2 === 0)
    }
    // Finder patterns, with their separators.
    this.drawFinderPattern(3, 3)
    this.drawFinderPattern(size - 4, 3)
    this.drawFinderPattern(3, size - 4)
    // Alignment patterns (skip the three that collide with finders).
    const positions = this.alignmentPatternPositions()
    const count = positions.length
    for (let i = 0; i < count; i += 1) {
      for (let j = 0; j < count; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) continue
        this.drawAlignmentPattern(positions[i], positions[j])
      }
    }
    // Reserve format and version areas with placeholder bits.
    this.drawFormatBits(0)
    this.drawVersionBits()
  }

  drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || xx >= this.size || yy < 0 || yy >= this.size) continue
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        this.setFunction(xx, yy, distance !== 2 && distance !== 4)
      }
    }
  }

  drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  alignmentPatternPositions() {
    if (this.version === 1) return []
    const count = Math.floor(this.version / 7) + 2
    const step =
      this.version === 32
        ? 26
        : Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2
    const result = [6]
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position)
    return result
  }

  /** Draws the 15 format bits for level M and `mask`, plus the dark module. */
  drawFormatBits(mask) {
    const data = (ECC_FORMAT_BITS_M << 3) | mask
    const bits = formatBits(data)
    const size = this.size
    for (let i = 0; i <= 5; i += 1) this.setFunction(8, i, bit(bits, i))
    this.setFunction(8, 7, bit(bits, 6))
    this.setFunction(8, 8, bit(bits, 7))
    this.setFunction(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i += 1) this.setFunction(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i += 1) this.setFunction(size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i += 1) this.setFunction(8, size - 15 + i, bit(bits, i))
    this.setFunction(8, size - 8, true)
  }

  drawVersionBits() {
    if (this.version < 7) return
    const bits = versionBits(this.version)
    for (let i = 0; i < 18; i += 1) {
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunction(a, b, bit(bits, i))
      this.setFunction(b, a, bit(bits, i))
    }
  }

  /** Places the interleaved codeword bits, then applies `mask`. */
  drawCodewords(codewords, mask) {
    const size = this.size
    let index = 0
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      const upward = ((right + 1) & 2) === 0
      for (let vertical = 0; vertical < size; vertical += 1) {
        for (let column = 0; column < 2; column += 1) {
          const x = right - column
          const y = upward ? size - 1 - vertical : vertical
          if (this.isFunction[y][x]) continue
          const dark = index < codewords.length * 8 && bit(codewords[index >> 3], 7 - (index & 7))
          this.modules[y][x] = dark
          index += 1
        }
      }
    }
    this.applyMask(mask)
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.isFunction[y][x]) continue
        if (maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  penalty() {
    const size = this.size
    let result = 0
    // N1: runs of five or more same-coloured modules in a row or column.
    for (let y = 0; y < size; y += 1) {
      let run = 1
      for (let x = 1; x <= size; x += 1) {
        if (x < size && this.modules[y][x] === this.modules[y][x - 1]) {
          run += 1
        } else {
          if (run >= 5) result += 3 + (run - 5)
          run = 1
        }
      }
    }
    for (let x = 0; x < size; x += 1) {
      let run = 1
      for (let y = 1; y <= size; y += 1) {
        if (y < size && this.modules[y][x] === this.modules[y - 1][x]) {
          run += 1
        } else {
          if (run >= 5) result += 3 + (run - 5)
          run = 1
        }
      }
    }
    // N2: 2x2 blocks of one colour.
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const colour = this.modules[y][x]
        if (colour === this.modules[y][x + 1] && colour === this.modules[y + 1][x] && colour === this.modules[y + 1][x + 1]) {
          result += 3
        }
      }
    }
    // N3: finder-like 1:1:3:1:1 patterns with four light modules on a side.
    const patternA = [true, false, true, true, true, false, true, false, false, false, false]
    const patternB = [false, false, false, false, true, false, true, true, true, false, true]
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x <= size - 11; x += 1) {
        let matchA = true
        let matchB = true
        for (let i = 0; i < 11; i += 1) {
          if (this.modules[y][x + i] !== patternA[i]) matchA = false
          if (this.modules[y][x + i] !== patternB[i]) matchB = false
        }
        if (matchA) result += 40
        if (matchB) result += 40
      }
    }
    for (let x = 0; x < size; x += 1) {
      for (let y = 0; y <= size - 11; y += 1) {
        let matchA = true
        let matchB = true
        for (let i = 0; i < 11; i += 1) {
          if (this.modules[y + i][x] !== patternA[i]) matchA = false
          if (this.modules[y + i][x] !== patternB[i]) matchB = false
        }
        if (matchA) result += 40
        if (matchB) result += 40
      }
    }
    // N4: deviation from an even dark/light balance, in 5% steps.
    let dark = 0
    for (const row of this.modules) for (const cell of row) if (cell) dark += 1
    const total = size * size
    result += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10
    return result
  }
}

function bit(value, index) {
  return ((value >>> index) & 1) !== 0
}

function formatBits(data) {
  let remainder = data
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  return (((data << 10) | remainder) ^ 0x5412) & 0x7fff
}

function versionBits(version) {
  let remainder = version
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  return ((version << 12) | remainder) & 0x3ffff
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      throw new QrEncodeError(`invalid mask pattern ${mask}`)
  }
}

// ---------------------------------------------------------------------------
// Block interleaving.
// ---------------------------------------------------------------------------

function addEccAndInterleave(data, version) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[version - 1]
  const blockEccLength = ECC_CODEWORDS_PER_BLOCK_M[version - 1]
  const rawCodewords = Math.floor(rawDataModules(version) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLength = Math.floor(rawCodewords / numBlocks)
  const shortDataLength = shortBlockLength - blockEccLength
  const divisor = reedSolomonDivisor(blockEccLength)

  const blocks = []
  for (let i = 0; i < numBlocks; i += 1) {
    const dataLength = shortDataLength + (i < numShortBlocks ? 0 : 1)
    const start = blocks.reduce((sum, block) => sum + block.data.length, 0)
    const blockData = data.subarray(start, start + dataLength)
    blocks.push({ data: blockData, ecc: reedSolomonRemainder(blockData, divisor) })
  }

  const result = []
  const maxDataLength = shortDataLength + (numShortBlocks < numBlocks ? 1 : 0)
  for (let i = 0; i < maxDataLength; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) result.push(block.data[i])
    }
  }
  for (let i = 0; i < blockEccLength; i += 1) {
    for (const block of blocks) result.push(block.ecc[i])
  }
  return Uint8Array.from(result)
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Encodes `text` as UTF-8 bytes in byte mode at error-correction level M,
 * choosing the smallest version that fits.
 * @param {string} text - non-empty payload.
 * @param {{mask?: number}} [options] - optional fixed mask pattern (0..7),
 *   used by the development cross-check against an independent encoder.
 * @returns {{matrix: boolean[][], version: number, size: number, mask: number}}
 *   a square boolean module matrix (true = dark) and the chosen mask.
 */
export function encodeQr(text, options = {}) {
  if (typeof text !== 'string') throw new QrEncodeError('the QR payload must be a string')
  const bytes = new TextEncoder().encode(text)
  if (bytes.length === 0) throw new QrEncodeError('the QR payload is empty')
  if (bytes.length > MAX_BYTE_LENGTH) {
    throw new QrEncodeError(
      `the input is too long for a QR code: ${bytes.length} bytes exceed the ${MAX_BYTE_LENGTH}-byte version 40-M limit`,
    )
  }
  const version = chooseVersion(bytes.length)
  const data = buildDataCodewords(bytes, version)
  const codewords = addEccAndInterleave(data, version)
  const symbol = new QrSymbol(version)
  symbol.drawFunctionPatterns()

  const forcedMask = options?.mask
  let bestMask = 0
  if (forcedMask !== undefined) {
    if (!Number.isInteger(forcedMask) || forcedMask < 0 || forcedMask > 7) {
      throw new QrEncodeError(`invalid mask pattern ${String(forcedMask)}`)
    }
    bestMask = forcedMask
  } else {
    let bestPenalty = Infinity
    for (let mask = 0; mask < 8; mask += 1) {
      symbol.drawCodewords(codewords, mask)
      symbol.drawFormatBits(mask)
      const penalty = symbol.penalty()
      if (penalty < bestPenalty) {
        bestPenalty = penalty
        bestMask = mask
      }
      symbol.applyMask(mask) // undo the mask, restoring raw data modules
    }
  }
  symbol.drawCodewords(codewords, bestMask)
  symbol.drawFormatBits(bestMask)

  return {
    matrix: symbol.modules.map(row => row.slice()),
    version,
    size: symbol.size,
    mask: bestMask,
  }
}

export default encodeQr
