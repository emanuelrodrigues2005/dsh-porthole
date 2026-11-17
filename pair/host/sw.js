/**
 * The Pair service worker, as a source string.
 *
 * It is deliberately tiny and dormant: no `fetch` listener, no `caches`, no
 * `importScripts`. A `push` message is only a tickle — the worker asks the gate
 * what happened under the device cookie and shows one notification per queued
 * item. That keeps notification content on the host and off the push service.
 *
 * The gate serves this string at `/dsh-pair-sw.js` with
 * `Service-Worker-Allowed: /`, so one worker owns the whole origin.
 */
export const SERVICE_WORKER_SOURCE = `/* DSH Pair service worker — served by the Pair gate at /dsh-pair-sw.js. */
'use strict'

var DRAIN_URL = '/pair/self/push/drain'
var FALLBACK_TAG = 'dsh-pair'
var FALLBACK = {
  title: 'DSH',
  body: 'Open DSH to see what happened.',
  url: '/'
}

self.addEventListener('install', function () {
  self.skipWaiting()
})

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', function (event) {
  event.waitUntil(
    drainItems()
      .then(function (items) {
        return showItems(items)
      })
      .catch(function () {
        return showFallback()
      })
  )
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var target = FALLBACK.url
  try {
    if (event.notification.data && typeof event.notification.data.url === 'string') {
      target = event.notification.data.url
    }
  } catch (error) {
    target = FALLBACK.url
  }
  event.waitUntil(openOrFocus(target))
})

function drainItems() {
  return fetch(DRAIN_URL, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json' }
  }).then(function (response) {
    if (!response.ok) throw new Error('drain answered ' + response.status)
    return response.json()
  }).then(function (payload) {
    if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.items)) return []
    return payload.items
  })
}

function showItems(items) {
  if (!Array.isArray(items) || items.length === 0) return showFallback()
  var shown = []
  for (var index = 0; index < items.length; index += 1) {
    var item = items[index]
    if (item === null || typeof item !== 'object') continue
    shown.push(showOne(item))
  }
  if (shown.length === 0) return showFallback()
  return Promise.all(shown)
}

function showOne(item) {
  var title = typeof item.title === 'string' && item.title.length > 0 ? item.title : FALLBACK.title
  var body = typeof item.body === 'string' && item.body.length > 0 ? item.body : FALLBACK.body
  var tag = typeof item.id === 'string' && item.id.length > 0 ? item.id : FALLBACK_TAG
  var url = typeof item.url === 'string' && item.url.length > 0 ? item.url : FALLBACK.url
  return self.registration.showNotification(title, {
    body: body,
    tag: tag,
    renotify: false,
    data: { url: url, category: typeof item.category === 'string' ? item.category : 'other' }
  })
}

function showFallback() {
  return self.registration.showNotification(FALLBACK.title, {
    body: FALLBACK.body,
    tag: FALLBACK_TAG,
    renotify: false,
    data: { url: FALLBACK.url, category: 'other' }
  })
}

function openOrFocus(target) {
  var url = typeof target === 'string' && target.length > 0 ? target : FALLBACK.url
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    for (var index = 0; index < windows.length; index += 1) {
      var candidate = windows[index]
      if (candidate && typeof candidate.focus === 'function') return candidate.focus()
    }
    if (typeof self.clients.openWindow === 'function') return self.clients.openWindow(url)
    return undefined
  })
}
`

export default SERVICE_WORKER_SOURCE
