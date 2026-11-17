/**
 * Contract tests for pair/host/sw.js — the Pair service worker source (S3).
 *
 * The worker is a string, so the contract is checked on its text: it must stay
 * dormant (no fetch listener, no caches, no imports), it must always show a
 * tagged notification, and its drain request must carry the device cookie.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SERVICE_WORKER_SOURCE } from '../host/sw.js'

const source = SERVICE_WORKER_SOURCE

test('the worker source is valid JavaScript', () => {
  assert.equal(typeof source, 'string')
  assert.ok(source.length > 500, 'the worker must actually do something')
  // `new Function` parses the body without running it, so no `self` is needed.
  assert.doesNotThrow(() => new Function(source))
})

test('the worker stays dormant: no fetch listener, no caches, no importScripts', () => {
  assert.equal(/addEventListener\(\s*['"]fetch['"]/u.test(source), false, 'a fetch listener would intercept the whole GUI')
  assert.equal(/\bcaches\b/u.test(source), false, 'no CacheStorage involvement')
  assert.equal(/importScripts/u.test(source), false, 'no third-party code')
})

test('install activates immediately and takes the clients', () => {
  assert.match(source, /addEventListener\(\s*'install'/u)
  assert.match(source, /skipWaiting\(\)/u)
  assert.match(source, /addEventListener\(\s*'activate'/u)
  assert.match(source, /clients\.claim\(\)/u)
})

test('a push drains the queue with the device cookie and never caches it', () => {
  assert.match(source, /addEventListener\(\s*'push'/u)
  assert.match(source, /\/pair\/self\/push\/drain/u)
  assert.match(source, /method:\s*'POST'/u)
  assert.match(source, /credentials:\s*'include'/u)
  assert.match(source, /cache:\s*'no-store'/u)
  assert.match(source, /waitUntil\(/u)
})

test('every notification is shown with a tag, and a failed drain still shows one', () => {
  assert.match(source, /showNotification\(/u)
  assert.match(source, /tag:/u)
  assert.match(source, /renotify:\s*false/u)
  // The catch branch must show a fallback notification, never nothing.
  assert.match(source, /\.catch\(function \(\) \{\s*return showFallback\(\)/u)
  const showCalls = source.match(/showNotification\(/gu) ?? []
  assert.ok(showCalls.length >= 2, 'both the item path and the fallback path show a notification')
})

test('a notification click focuses an existing window or opens the app root', () => {
  assert.match(source, /addEventListener\(\s*'notificationclick'/u)
  assert.match(source, /\.close\(\)/u)
  assert.match(source, /clients\.matchAll\(/u)
  assert.match(source, /\.focus\(\)/u)
  assert.match(source, /openWindow\(/u)
  assert.match(source, /url:\s*'\/'/u)
  assert.equal(/https?:\/\//u.test(source), false, 'the worker must only ever talk to its own origin')
})
