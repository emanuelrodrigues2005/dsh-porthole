/**
 * QR rendering for the Pair panel.
 *
 * The encoder itself is vendored at `./vendor/qrcodegen.js` (byte mode,
 * error-correction level M, automatic version). This module owns the public
 * contract used by the host routes and the panel: a boolean matrix and a
 * self-contained SVG string with deterministic geometry.
 */
import { encodeQr, QrEncodeError } from './vendor/qrcodegen.js'

/** Maximum number of characters accepted for one QR payload. */
export const MAX_INPUT_LENGTH = 1200

const DEFAULT_SCALE = 4
const DEFAULT_MARGIN = 4
const MAX_SCALE = 64
const MAX_MARGIN = 64

function qrError(code, message) {
  const error = new Error(message)
  error.name = 'QrCodeError'
  error.code = code
  return error
}

function encode(text) {
  if (typeof text !== 'string') {
    throw qrError('QR_INPUT_INVALID', 'the QR payload must be a string')
  }
  if (text.length === 0) {
    throw qrError('QR_INPUT_EMPTY', 'the QR payload is empty')
  }
  if ([...text].length > MAX_INPUT_LENGTH) {
    throw qrError(
      'QR_INPUT_TOO_LONG',
      `the QR payload is too long: the maximum is ${MAX_INPUT_LENGTH} characters`,
    )
  }
  try {
    return encodeQr(text)
  } catch (error) {
    if (error instanceof QrEncodeError) {
      throw qrError('QR_DATA_TOO_LONG', error.message)
    }
    throw error
  }
}

function dimensionOption(value, fallback, name, minimum) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > MAX_SCALE) {
    throw qrError(
      'QR_ARGUMENT_INVALID',
      `${name} must be an integer between ${minimum} and ${MAX_SCALE}`,
    )
  }
  return value
}

/**
 * Encodes `text` and returns a square boolean module matrix.
 * @param {string} text - pairing URL or other payload (non-empty, at most 1200 characters).
 * @returns {boolean[][]} rows of modules; `true` is a dark module.
 */
export function qrMatrix(text) {
  return encode(text).matrix
}

/**
 * Encodes `text` as a self-contained SVG string.
 * @param {string} text - payload passed to {@link qrMatrix}.
 * @param {{scale?: number, margin?: number}} [options] - module pixel size and
 *   quiet-zone width in modules (both default to 4).
 * @returns {string} an `<svg>` document with `width`, `height` and `viewBox`.
 */
export function qrSvg(text, options = {}) {
  const { matrix } = encode(text)
  const scale = dimensionOption(options?.scale, DEFAULT_SCALE, 'scale', 1)
  const margin = dimensionOption(options?.margin, DEFAULT_MARGIN, 'margin', 0)
  const size = matrix.length
  const dimension = (size + margin * 2) * scale

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">`,
    `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>`,
    '<g fill="#000000">',
  ]
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (!matrix[row][column]) continue
      const x = (column + margin) * scale
      const y = (row + margin) * scale
      parts.push(`<rect x="${x}" y="${y}" width="${scale}" height="${scale}"/>`)
    }
  }
  parts.push('</g></svg>')
  return parts.join('')
}

export default qrSvg
