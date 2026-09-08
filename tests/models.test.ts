import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'

import { SubscriptionError, type FailureCode } from '../src/errors.js'
import {
  discoverOpenAIModels,
  configureModelContext,
  describeModelContexts,
  mergeModelCatalog,
  parseOpenAIModelCatalog,
  removeManagedModels,
  type ModelFetch,
} from '../src/models.js'

function failure(code: FailureCode): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof SubscriptionError)
    assert.equal(error.code, code)
    assert.equal(error.message, `[openai-subscription:${code}]`)
    assert.equal(error.cause, undefined)
    return true
  }
}

test('parses picker-visible models from the live Codex response', () => {
  assert.deepEqual(parseOpenAIModelCatalog({
    models: [
      {
        slug: 'later',
        display_name: 'Later',
        visibility: 'list',
        priority: 20,
        context_window: 128_000,
        input_modalities: ['text', 'image', 'audio', 'text'],
        supported_reasoning_levels: [
          { effort: 'none' },
          { effort: 'low' },
          { effort: 'xhigh' },
          { effort: 'ultra' },
        ],
      },
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
      {
        slug: 'first',
        display_name: 'First',
        visibility: 'list',
        priority: 1,
        max_context_window: 64_000,
        supported_reasoning_levels: [{ effort: 'none' }],
      },
      { slug: 'first', display_name: 'Duplicate', visibility: 'list', priority: 2 },
      { slug: 'missing-visibility', display_name: 'Internal default' },
      { display_name: 'Missing id', visibility: 'list' },
    ],
  }), {
    models: [
      { id: 'first', name: 'First', contextWindow: 64_000, reasoningEfforts: false },
      {
        id: 'later',
        name: 'Later',
        contextWindow: 128_000,
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', xhigh: 'xhigh' },
      },
    ],
    seenIds: ['later', 'hidden', 'first', 'missing-visibility'],
    contextLimits: [{ id: 'first', maxContextWindow: 64_000 }],
  })
})

test('keeps the default context separate from an opt-in million-token maximum', () => {
  const result = parseOpenAIModelCatalog({ models: [
    { slug: 'large', visibility: 'list', context_window: 272_000, max_context_window: 1_050_000 },
    { slug: 'small', visibility: 'list', context_window: 128_000, max_context_window: 128_000 },
    { slug: 'inconsistent', visibility: 'list', context_window: 2_000_000, max_context_window: 1_000_000 },
    { slug: 'hidden', visibility: 'hide', context_window: 1_000_000, max_context_window: 2_000_000 },
    { slug: 'large', visibility: 'list', context_window: 2_000_000, max_context_window: 3_000_000 },
  ] })
  assert.deepEqual(result.models, [
    { id: 'large', contextWindow: 272_000 },
    { id: 'small', contextWindow: 128_000 },
    { id: 'inconsistent', contextWindow: 1_000_000 },
  ])
  assert.deepEqual(result.contextLimits, [
    { id: 'large', maxContextWindow: 1_050_000 },
    { id: 'small', maxContextWindow: 128_000 },
    { id: 'inconsistent', maxContextWindow: 1_000_000 },
  ])
  assert.equal('maxContextWindow' in result.models[0]!, false)
})

test('ignores invalid context capacities without inventing a maximum', () => {
  for (const invalid of [undefined, null, '1000000', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(parseOpenAIModelCatalog({ models: [
      { slug: 'default', visibility: 'list', context_window: 128_000, max_context_window: invalid },
      { slug: 'fallback', visibility: 'list', context_window: invalid, max_context_window: 1_000_000 },
      { slug: 'unknown', visibility: 'list', context_window: invalid, max_context_window: invalid },
    ] }), {
      models: [{ id: 'default', contextWindow: 128_000 }, { id: 'fallback', contextWindow: 1_000_000 }, { id: 'unknown' }],
      seenIds: ['default', 'fallback', 'unknown'],
      contextLimits: [{ id: 'fallback', maxContextWindow: 1_000_000 }],
    })
  }
})

test('rejects malformed or empty live model catalogs with stable codes', () => {
  for (const value of [null, [], 'secret response', { data: [] }, { models: {} }]) {
    assert.throws(() => parseOpenAIModelCatalog(value), failure('invalid-response'))
  }
  for (const models of [[], [{ slug: 'hidden', visibility: 'hide' }], [null, { visibility: 'list' }]]) {
    assert.throws(() => parseOpenAIModelCatalog({ models }), failure('models-empty'))
  }
})

test('fetches models with the subscription credential and account scope', async () => {
  let requestedUrl = ''
  let requestedInit: RequestInit | undefined
  const fetcher: ModelFetch = async (input, init) => {
    requestedUrl = String(input)
    requestedInit = init
    return new Response(JSON.stringify({
      models: [{ slug: 'gpt-live', display_name: 'GPT Live', visibility: 'list', priority: 1 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  assert.deepEqual(await discoverOpenAIModels(
    { access: 'secret-access', accountId: 'workspace-id' },
    { fetch: fetcher, timeoutMs: 1_000 },
  ), { models: [{ id: 'gpt-live', name: 'GPT Live' }], seenIds: ['gpt-live'] })

  const url = new URL(requestedUrl)
  assert.equal(url.origin + url.pathname, 'https://chatgpt.com/backend-api/codex/models')
  assert.equal(url.searchParams.get('client_version'), '0.0.0')
  assert.equal(requestedInit?.method, 'GET')
  assert.equal(requestedInit?.redirect, 'error')
  const headers = new Headers(requestedInit?.headers)
  assert.equal(headers.get('authorization'), 'Bearer secret-access')
  assert.equal(headers.get('chatgpt-account-id'), 'workspace-id')
  assert.equal(headers.get('originator'), 'dsh-openai-subscription')
})

for (const [status, code] of [
  [401, 'authorization-expired'],
  [403, 'access-denied'],
  [429, 'rate-limited'],
  [302, 'models-unavailable'],
  [404, 'models-unavailable'],
  [500, 'models-unavailable'],
  [503, 'models-unavailable'],
] as const) {
  test(`classifies HTTP ${status}, cancels without reading, and never retries`, async () => {
    let requests = 0
    let reads = 0
    let cancellations = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        controller.enqueue(new TextEncoder().encode('secret-access sensitive upstream response'))
      },
      cancel() {
        cancellations++
        throw new Error('sensitive cancellation diagnostic')
      },
    }, { highWaterMark: 0 })
    const response = new Response(stream, { status, statusText: 'sensitive status text' })
    await assert.rejects(discoverOpenAIModels({ access: 'secret-access' }, {
      fetch: async () => {
        requests++
        return response
      },
    }), failure(code))
    assert.equal(requests, 1)
    assert.equal(reads, 0)
    assert.equal(cancellations, 1)
    assert.equal(stream.locked, false)
  })
}

test('sanitizes network failures without retaining a remote cause', async () => {
  for (const remote of [new Error('Bearer secret-access proxy sensitive response'), 'secret-access']) {
    let requests = 0
    await assert.rejects(discoverOpenAIModels({ access: 'secret-access' }, {
      fetch: async () => {
        requests++
        throw remote
      },
    }), failure('network'))
    assert.equal(requests, 1)
  }
})

test('rejects malformed JSON and empty catalogs without exposing remote text', async () => {
  for (const [body, code] of [
    ['secret-access sensitive invalid JSON', 'invalid-response'],
    [JSON.stringify({ error: 'secret-access sensitive upstream response' }), 'invalid-response'],
    [JSON.stringify({ models: [] }), 'models-empty'],
  ] as const) {
    const response = new Response(body)
    await assert.rejects(discoverOpenAIModels({ access: 'secret-access' }, {
      fetch: async () => response,
    }), failure(code))
    assert.equal(response.body?.locked, false)
  }
})

test('rejects missing credentials and invalid deadlines before fetching', async () => {
  let requests = 0
  const fetcher: ModelFetch = async () => {
    requests++
    return new Response('{}')
  }
  await assert.rejects(discoverOpenAIModels({ access: '  ' }, { fetch: fetcher }), failure('not-connected'))
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(discoverOpenAIModels({ access: 'secret' }, { fetch: fetcher, timeoutMs }), failure('invalid-response'))
  }
  assert.equal(requests, 0)
})

test('pre-aborted discovery never fetches or exposes its cancellation reason', async () => {
  const controller = new AbortController()
  controller.abort(new Error('secret-access sensitive abort reason'))
  let requests = 0
  await assert.rejects(discoverOpenAIModels({ access: 'secret-access' }, {
    signal: controller.signal,
    fetch: async () => {
      requests++
      return new Response('{}')
    },
  }), failure('cancelled'))
  assert.equal(requests, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('releases successful response readers and removes abort listeners', async () => {
  const parent = new AbortController()
  let requestSignal: AbortSignal | null | undefined
  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"models":[{"slug":"live","visibility":"list"}]}'))
      controller.close()
    },
    cancel() { cancellations++ },
  })
  assert.deepEqual(await discoverOpenAIModels({ access: 'secret' }, {
    signal: parent.signal,
    fetch: async (_input, init) => {
      requestSignal = init?.signal
      return new Response(stream)
    },
  }), { models: [{ id: 'live' }], seenIds: ['live'] })
  assert.equal(cancellations, 0)
  assert.equal(stream.locked, false)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  assert.ok(requestSignal)
  assert.equal(getEventListeners(requestSignal, 'abort').length, 0)
  parent.abort()
  assert.equal(requestSignal.aborted, false)
})

test('cancels a non-cooperative fetch and cleans up its late response', { timeout: 1_000 }, async () => {
  const parent = new AbortController()
  let requestSignal: AbortSignal | null | undefined
  let resolveFetch!: (response: Response) => void
  let requests = 0
  const result = discoverOpenAIModels({ access: 'secret' }, {
    signal: parent.signal,
    fetch: (_input, init) => {
      requests++
      requestSignal = init?.signal
      return new Promise<Response>((resolve) => { resolveFetch = resolve })
    },
  })
  parent.abort(new Error('sensitive abort reason'))
  await assert.rejects(result, failure('cancelled'))
  assert.equal(requests, 1)
  assert.ok(requestSignal)
  assert.equal(requestSignal.aborted, true)
  assert.equal(getEventListeners(requestSignal, 'abort').length, 0)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)

  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancellations++ },
  })
  resolveFetch(new Response(stream))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(cancellations, 1)
  assert.equal(stream.locked, false)
})

test('times out a non-cooperative fetch without retrying', { timeout: 1_000 }, async () => {
  let requests = 0
  let requestSignal: AbortSignal | null | undefined
  await assert.rejects(discoverOpenAIModels({ access: 'secret' }, {
    timeoutMs: 10,
    fetch: (_input, init) => {
      requests++
      requestSignal = init?.signal
      return new Promise<Response>(() => {})
    },
  }), failure('timeout'))
  assert.equal(requests, 1)
  assert.ok(requestSignal)
  assert.equal(requestSignal.aborted, true)
  assert.equal(getEventListeners(requestSignal, 'abort').length, 0)
})

test('cancels and releases a stalled response reader on caller abort', { timeout: 1_000 }, async () => {
  const parent = new AbortController()
  let cancellations = 0
  let started!: () => void
  const reading = new Promise<void>((resolve) => { started = resolve })
  const stream = new ReadableStream<Uint8Array>({
    pull() { started() },
    cancel() {
      cancellations++
      return Promise.reject(new Error('sensitive cancellation failure'))
    },
  }, { highWaterMark: 0 })
  const result = discoverOpenAIModels({ access: 'secret' }, {
    signal: parent.signal,
    fetch: async () => new Response(stream),
  })
  await reading
  parent.abort(new Error('sensitive caller reason'))
  await assert.rejects(result, failure('cancelled'))
  assert.equal(cancellations, 1)
  assert.equal(stream.locked, false)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
})

test('bounds streamed bytes and cancels and releases an oversized body', async () => {
  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3 * 1024 * 1024))
      controller.enqueue(new Uint8Array(2 * 1024 * 1024))
    },
    cancel() { cancellations++ },
  })
  await assert.rejects(discoverOpenAIModels({ access: 'secret' }, {
    fetch: async () => new Response(stream),
    timeoutMs: 1_000,
  }), failure('invalid-response'))
  assert.equal(cancellations, 1)
  assert.equal(stream.locked, false)
})

test('cancels oversized content-length responses without reading or waiting for cancellation', { timeout: 1_000 }, async () => {
  for (const contentLength of [String(4 * 1024 * 1024 + 1), '9'.repeat(400)]) {
    let reads = 0
    let cancellations = 0
    const stream = new ReadableStream<Uint8Array>({
      pull() { reads++ },
      cancel() {
        cancellations++
        return new Promise<void>(() => {})
      },
    }, { highWaterMark: 0 })
    await assert.rejects(discoverOpenAIModels({ access: 'secret' }, {
      fetch: async () => new Response(stream, { headers: { 'content-length': contentLength } }),
    }), failure('invalid-response'))
    assert.equal(reads, 0)
    assert.equal(cancellations, 1)
    assert.equal(stream.locked, false)
  }
})

test('sanitizes stream errors and releases the reader', async () => {
  const parent = new AbortController()
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error('Bearer secret-access sensitive stream error')) },
  }, { highWaterMark: 0 })
  await assert.rejects(discoverOpenAIModels({ access: 'secret-access' }, {
    signal: parent.signal,
    fetch: async () => new Response(stream),
  }), failure('network'))
  assert.equal(stream.locked, false)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
})

test('applies the deadline to stalled bodies even when stream cancellation never settles', { timeout: 1_000 }, async () => {
  const parent = new AbortController()
  let requestSignal: AbortSignal | null | undefined
  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++
      return new Promise<void>(() => {})
    },
  })
  await assert.rejects(discoverOpenAIModels({ access: 'secret' }, {
    signal: parent.signal,
    fetch: async (_input, init) => {
      requestSignal = init?.signal
      return new Response(stream)
    },
    timeoutMs: 10,
  }), failure('timeout'))
  assert.equal(cancellations, 1)
  assert.equal(stream.locked, false)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  assert.ok(requestSignal)
  assert.equal(requestSignal.aborted, true)
  assert.equal(getEventListeners(requestSignal, 'abort').length, 0)
})

test('refreshes managed models without overwriting local additions or edits', () => {
  const previous = [
    { id: 'alpha', name: 'Alpha', contextWindow: 100 },
    { id: 'beta', name: 'Beta', contextWindow: 100 },
  ]
  const existing = [
    { id: 'alpha', name: 'Alpha', contextWindow: 100 },
    { id: 'beta', name: 'My Beta', contextWindow: 100 },
    { id: 'private-model', name: 'Private' },
  ]
  const discovered = [
    { id: 'gamma', name: 'Gamma', contextWindow: 200 },
    { id: 'beta', name: 'Beta v2', contextWindow: 200 },
    { id: 'alpha', name: 'Alpha v2', contextWindow: 200 },
  ]

  assert.deepEqual(mergeModelCatalog(existing, previous, discovered), {
    models: [
      { id: 'gamma', name: 'Gamma', contextWindow: 200 },
      { id: 'beta', name: 'My Beta', contextWindow: 200 },
      { id: 'alpha', name: 'Alpha v2', contextWindow: 200 },
      { id: 'private-model', name: 'Private' },
    ],
    managed: discovered,
    suppressed: [],
  })
  assert.deepEqual(removeManagedModels(existing, previous), [
    { id: 'beta', name: 'My Beta', contextWindow: 100 },
    { id: 'private-model', name: 'Private' },
  ])
})

test('unions a first remote snapshot with an existing explicit model list', () => {
  assert.deepEqual(mergeModelCatalog(
    [{ id: 'custom' }, { id: 'remote', name: 'Locally named' }],
    undefined,
    [{ id: 'remote', name: 'Remote name' }, { id: 'new' }],
  ), {
    models: [{ id: 'remote', name: 'Locally named' }, { id: 'new' }, { id: 'custom' }],
    managed: [{ id: 'remote', name: 'Remote name' }, { id: 'new' }],
    suppressed: [],
  })
})

test('keeps explicitly removed managed models suppressed across refreshes', () => {
  const previous = [{ id: 'removed', name: 'Removed' }, { id: 'kept', name: 'Kept' }]
  const next = [{ id: 'removed', name: 'Removed v2' }, { id: 'kept', name: 'Kept v2' }, { id: 'new' }]
  const first = mergeModelCatalog([{ id: 'kept', name: 'Kept' }], previous, next)
  assert.deepEqual(first, {
    models: [{ id: 'kept', name: 'Kept v2' }, { id: 'new' }],
    managed: next,
    suppressed: ['removed'],
  })

  assert.deepEqual(mergeModelCatalog(first.models, first.managed, next, first.suppressed), first)
})

test('describes whitelisted context facts and distinguishes deleted fields from defaults', () => {
  assert.deepEqual(describeModelContexts([
    { id: 'large', name: 'Large', contextWindow: 1_000_000, secret: 'do not expose', compat: { secret: true } },
    { id: 'deleted' },
    { id: 'unknown' },
    { id: 'custom', contextWindow: 256_000 },
    { id: 'new-model' },
  ], [
    { id: 'large', contextWindow: 272_000 },
    { id: 'deleted', contextWindow: 272_000 },
    { id: 'unknown' },
    { id: 'new-model' },
  ], [
    { id: 'large', maxContextWindow: 1_050_000, catalogContextWindow: 400_000, secret: 'private' },
    { id: 'deleted', maxContextWindow: 1_050_000, catalogContextWindow: 400_000 },
    { id: 'new-model' },
  ], 128_000), [
    { id: 'large', name: 'Large', contextWindow: 1_000_000, defaultContextWindow: 272_000, maxContextWindow: 1_050_000, customized: true },
    { id: 'deleted', contextWindow: 400_000, defaultContextWindow: 272_000, maxContextWindow: 1_050_000, customized: true },
    { id: 'unknown', customized: false },
    { id: 'custom', contextWindow: 256_000, customized: true },
    { id: 'new-model', contextWindow: 128_000, defaultContextWindow: 128_000, customized: false },
  ])
})

test('configures one million tokens as a local edit surviving repeated catalog refreshes', () => {
  const previous = [
    { id: 'large', name: 'Large', contextWindow: 272_000 },
    { id: 'small', contextWindow: 128_000 },
  ]
  const existing = [...previous, { id: 'custom', compat: { local: true } }]
  const facts = [{ id: 'large', maxContextWindow: 1_050_000 }]
  const configured = configureModelContext(existing, previous, facts, 'large', 1_000_000)
  assert.deepEqual(configured, [{ id: 'large', name: 'Large', contextWindow: 1_000_000 }, ...existing.slice(1)])
  assert.deepEqual(existing[0], { id: 'large', name: 'Large', contextWindow: 272_000 })
  assert.equal(previous[0]!.contextWindow, 272_000)
  const remote = [{ id: 'large', name: 'Updated', contextWindow: 300_000 }, { id: 'small', contextWindow: 128_000 }]
  const merged = mergeModelCatalog(configured, previous, remote)
  assert.deepEqual(merged.models, [{ id: 'large', name: 'Updated', contextWindow: 1_000_000 }, ...existing.slice(1)])
  assert.deepEqual(merged.managed, remote)
  assert.deepEqual(mergeModelCatalog(merged.models, merged.managed, remote), merged)
  assert.deepEqual(removeManagedModels(merged.models, merged.managed), [merged.models[0], existing[2]])
  assert.deepEqual(configureModelContext(merged.models, remote, facts, 'large', null), [...remote, existing[2]])
})

test('restoring context defaults removes a local-only override and preserves other edits', () => {
  const previous = [{ id: 'builtin' }]
  const existing = [{ id: 'builtin', name: 'Local name', contextWindow: 1_000_000, maxTokens: 32_000 }]
  const restored = configureModelContext(existing, previous, undefined, 'builtin', null)
  assert.deepEqual(restored, [{ id: 'builtin', name: 'Local name', maxTokens: 32_000 }])
  assert.deepEqual(configureModelContext([{ id: 'custom', contextWindow: 1_000_000 }], [], [], 'custom', null), [{ id: 'custom' }])
  const deleted = mergeModelCatalog([{ id: 'remote', name: 'Remote' }], [{ id: 'remote', contextWindow: 272_000 }], [{ id: 'remote', contextWindow: 300_000 }])
  assert.deepEqual(deleted.models, [{ id: 'remote', name: 'Remote' }])
})

test('context updates reject invalid values, unknown ids and disclosed limit violations', () => {
  const existing = [{ id: 'small', contextWindow: 128_000 }]
  const facts = [{ id: 'small', maxContextWindow: 128_000 }]
  for (const value of [undefined, '1000000', '', true, false, {}, [], 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => configureModelContext(existing, existing, facts, 'small', value), failure('invalid-context-window'))
  }
  for (const id of [null, undefined, [], {}, '', 'other', '__proto__']) {
    assert.throws(() => configureModelContext(existing, existing, facts, id, 100), failure('model-not-found'))
  }
  assert.throws(() => configureModelContext(existing, existing, facts, 'small', 1_000_000), failure('context-window-exceeded'))
  assert.throws(() => configureModelContext([], existing, facts, 'small', 100), failure('model-not-found'))
  assert.throws(() => configureModelContext([...existing, ...existing], existing, facts, 'small', 100), failure('model-not-found'))
  assert.deepEqual(configureModelContext(existing, existing, facts, 'small', 128_000), existing)
  assert.deepEqual(configureModelContext(existing, existing, [], 'small', 1_000_000), [{ id: 'small', contextWindow: 1_000_000 }])
})

test('treats an absent or empty explicit list as an implicit-catalog reset', () => {
  const previous = [{ id: 'old', name: 'Old' }]
  const next = [{ id: 'old', name: 'Updated' }, { id: 'new' }]
  const expected = { models: next, managed: next, suppressed: [] }

  assert.deepEqual(mergeModelCatalog(undefined, previous, next, ['old']), expected)
  assert.deepEqual(mergeModelCatalog([], previous, next, ['old']), expected)
})
