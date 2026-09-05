import assert from 'node:assert/strict'
import test from 'node:test'

import {
  discoverOpenAIModels,
  mergeModelCatalog,
  parseOpenAIModelCatalog,
  removeManagedModels,
  type ModelFetch,
} from '../src/models.js'

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
  })
})

test('rejects malformed or empty live model catalogs', () => {
  assert.throws(() => parseOpenAIModelCatalog({ data: [] }), /无效数据/)
  assert.throws(() => parseOpenAIModelCatalog({ models: [{ slug: 'hidden', visibility: 'hide' }] }), /没有返回可用模型/)
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

test('reports authorization failures without exposing response bodies', async () => {
  const fetcher: ModelFetch = async () => new Response('sensitive upstream response', { status: 401 })
  await assert.rejects(
    discoverOpenAIModels({ access: 'expired' }, { fetch: fetcher }),
    (error: unknown) => {
      assert.match(String((error as Error).message), /授权已失效/)
      assert.doesNotMatch(String((error as Error).message), /sensitive/)
      return true
    },
  )
})

test('bounds streamed response bodies before allocating the complete payload', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3 * 1024 * 1024))
      controller.enqueue(new Uint8Array(2 * 1024 * 1024))
      controller.close()
    },
  })
  await assert.rejects(
    discoverOpenAIModels(
      { access: 'secret' },
      { fetch: async () => new Response(stream), timeoutMs: 1_000 },
    ),
    /数据过大/,
  )
})

test('applies the timeout while reading a stalled response body', async () => {
  const stream = new ReadableStream<Uint8Array>({ start() {} })
  await assert.rejects(
    discoverOpenAIModels(
      { access: 'secret' },
      { fetch: async () => new Response(stream), timeoutMs: 10 },
    ),
    /超时/,
  )
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

test('treats an absent or empty explicit list as an implicit-catalog reset', () => {
  const previous = [{ id: 'old', name: 'Old' }]
  const next = [{ id: 'old', name: 'Updated' }, { id: 'new' }]
  const expected = { models: next, managed: next, suppressed: [] }

  assert.deepEqual(mergeModelCatalog(undefined, previous, next, ['old']), expected)
  assert.deepEqual(mergeModelCatalog([], previous, next, ['old']), expected)
})
