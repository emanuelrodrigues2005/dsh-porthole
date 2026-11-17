/**
 * Contract tests for pair/host/qr.js.
 *
 * The QR encoder is validated structurally: symbol size, finder patterns,
 * determinism, quiet-zone accounting in the SVG, and input limits. A decoder
 * is out of scope (no dependencies, offline).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { qrSvg, qrMatrix } from '../host/qr.js'

const DEFAULT_SCALE = 4
const DEFAULT_MARGIN = 4
const FINDER_SIZE = 7
const MAX_INPUT = 1200

function numericAttribute(svg, name) {
  const match = svg.match(new RegExp(`\\b${name}="([0-9]+(?:\\.[0-9]+)?)"`))
  assert.ok(match, `SVG is missing a numeric ${name} attribute: ${svg.slice(0, 200)}`)
  return Number(match[1])
}

function assertFinder(matrix, top, left, corner) {
  const size = matrix.length
  assert.ok(top >= 0 && left >= 0 && top + FINDER_SIZE <= size && left + FINDER_SIZE <= size, `${corner} finder out of bounds`)
  for (let row = 0; row < FINDER_SIZE; row += 1) {
    for (let column = 0; column < FINDER_SIZE; column += 1) {
      const border = row === 0 || row === FINDER_SIZE - 1 || column === 0 || column === FINDER_SIZE - 1
      const center = row >= 2 && row <= 4 && column >= 2 && column <= 4
      const expected = border || center
      assert.equal(
        matrix[top + row][left + column],
        expected,
        `${corner} finder pattern is wrong at (${top + row}, ${left + column})`,
      )
    }
  }
}

function assertQrCodeError(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error?.code, code, `expected code ${code}, got ${error?.code}: ${error?.message}`)
    return true
  })
}

test('qrMatrix returns a square boolean matrix of size 21 for HELLO', () => {
  const matrix = qrMatrix('HELLO')

  assert.ok(Array.isArray(matrix))
  assert.equal(matrix.length, 21)
  for (const row of matrix) {
    assert.ok(Array.isArray(row))
    assert.equal(row.length, 21, 'the matrix must be square')
    for (const cell of row) assert.equal(typeof cell, 'boolean')
  }
})

test('qrMatrix is deterministic and depends on the input', () => {
  assert.deepEqual(qrMatrix('HELLO'), qrMatrix('HELLO'))
  assert.notDeepEqual(qrMatrix('HELLO'), qrMatrix('WORLD'))
})

test('qrMatrix grows in 4-module steps for longer input', () => {
  const short = qrMatrix('HELLO')
  const long = qrMatrix('A'.repeat(100))

  assert.ok(long.length > short.length, 'a longer payload must need a larger symbol')
  assert.equal((long.length - 21) % 4, 0, 'QR versions grow the symbol by 4 modules')
  for (const row of long) assert.equal(row.length, long.length)
})

test('qrMatrix contains finder patterns in the top-left, top-right and bottom-left corners', () => {
  const matrix = qrMatrix('HELLO')
  const size = matrix.length

  assertFinder(matrix, 0, 0, 'top-left')
  assertFinder(matrix, 0, size - FINDER_SIZE, 'top-right')
  assertFinder(matrix, size - FINDER_SIZE, 0, 'bottom-left')
})

test('qrSvg renders an svg with a square size that accounts for the quiet-zone margin', () => {
  const matrix = qrMatrix('HELLO')
  const svg = qrSvg('HELLO')

  assert.match(svg, /^<svg[\s>]/)
  assert.match(svg, /viewBox="/)
  const width = numericAttribute(svg, 'width')
  const height = numericAttribute(svg, 'height')
  assert.equal(width, height, 'the rendered svg must be square')
  assert.equal(width, (matrix.length + 2 * DEFAULT_MARGIN) * DEFAULT_SCALE)
})

test('qrSvg scales and pads by the requested scale and margin', () => {
  const matrix = qrMatrix('HELLO')
  const defaultWidth = numericAttribute(qrSvg('HELLO'), 'width')

  assert.equal(numericAttribute(qrSvg('HELLO', { scale: 8 }), 'width'), defaultWidth * 2)
  assert.equal(
    numericAttribute(qrSvg('HELLO', { margin: 0 }), 'width'),
    defaultWidth - 2 * DEFAULT_MARGIN * DEFAULT_SCALE,
    'margin must add a quiet zone of `margin` modules on each side',
  )
  assert.equal(
    numericAttribute(qrSvg('HELLO', { scale: 2, margin: 1 }), 'width'),
    (matrix.length + 2) * 2,
  )
})

test('qrSvg is deterministic and depends on the input', () => {
  assert.equal(qrSvg('HELLO'), qrSvg('HELLO'))
  assert.notEqual(qrSvg('HELLO'), qrSvg('WORLD'))
})

test('qrSvg and qrMatrix refuse empty input with QR_INPUT_EMPTY', () => {
  assertQrCodeError(() => qrSvg(''), 'QR_INPUT_EMPTY')
  assertQrCodeError(() => qrMatrix(''), 'QR_INPUT_EMPTY')
})

test('qrSvg refuses input longer than 1200 characters but accepts exactly 1200', () => {
  assert.throws(
    () => qrSvg('a'.repeat(MAX_INPUT + 1)),
    error => {
      const coded = typeof error?.code === 'string' && error.code.startsWith('QR_')
      const explained = /too long|maximum|1200|length/i.test(String(error?.message))
      assert.ok(coded || explained, `expected a QR input-length error, got ${error?.code}: ${error?.message}`)
      return true
    },
  )

  const svg = qrSvg('a'.repeat(MAX_INPUT))
  assert.match(svg, /^<svg[\s>]/)
})
