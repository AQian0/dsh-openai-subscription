import assert from 'node:assert/strict'
import test from 'node:test'

import OpenAISubscriptionController from '../src/host.js'
import type { DiscoveredModelCatalog } from '../src/models.js'

const MAIN_KEY = 'dsh-openai-subscription/chatgpt'
const ADAPTER_KEY = 'llm-pi-ai/openai-codex'

interface StoredRecord {
  kind: 'grant'
  payload: Record<string, unknown>
}

interface ControllerHarness {
  ctx: { get(name: string): unknown }
  registeredAuthorization: unknown
  cachedModule: string | null
  locatingModule: Promise<string> | null
  syncingModels: Promise<{ synced: true; count: number }> | null
  modelSyncController: AbortController | null
  modelDiscovery: (credential: { access: string; accountId?: string }) => Promise<DiscoveredModelCatalog>
  pendingBridge: {
    notices: Array<{ message: string; url?: string; code?: string }>
    done: boolean
    outcome: 'authorized' | 'cancelled' | 'failed' | null
    error: string | null
    controller: AbortController
    task: Promise<void> | null
  } | null
  status: OpenAISubscriptionController['status']
  runRefresh(
    control: { signal: AbortSignal; aborted(): boolean },
    notify: (notice: { kind?: string; message?: string }) => void,
  ): Promise<unknown>
  synchronizeModels(signal?: AbortSignal, adoptExistingModels?: boolean): Promise<{ synced: true; count: number }>
  syncModels: OpenAISubscriptionController['syncModels']
  logout: OpenAISubscriptionController['logout']
}

function controllerWith(services: Record<string, unknown>): ControllerHarness {
  const controller = Object.create(OpenAISubscriptionController.prototype) as ControllerHarness
  controller.ctx = { get: (name) => services[name] }
  controller.registeredAuthorization = null
  controller.cachedModule = '/trusted/openai-codex.js'
  controller.locatingModule = null
  controller.syncingModels = null
  controller.modelSyncController = null
  controller.modelDiscovery = async () => { throw new Error('unexpected model discovery') }
  controller.pendingBridge = null
  return controller
}

test('status returns semantic connection and model-sync facts without account metadata', async () => {
  const managedModels = [{ id: 'gpt-live', name: 'GPT Live' }]
  const records: Record<string, { kind: string; payload: Record<string, unknown> }> = {
    [MAIN_KEY]: {
      kind: 'grant',
      payload: { accountId: 'internal-account', expires: 1, managedModels },
    },
    [ADAPTER_KEY]: {
      kind: 'grant',
      payload: { type: 'oauth', access: 'live-access', refresh: 'live-refresh', expires: 2_000_000_000_000, accountId: 'internal-account' },
    },
  }
  const controller = controllerWith({
    credentials: { readRecord: async (key: string) => records[key] },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        user: { providers: { 'openai-codex': { models: managedModels } } },
        value: { providers: { 'openai-codex': { models: managedModels } } },
      }],
    },
  })

  const status = await controller.status()
  assert.deepEqual(status, {
    configured: true,
    ready: true,
    refreshable: true,
    modelsSynced: true,
    modelCount: 1,
  })
  assert.equal('accountId' in status, false)
  assert.equal('expires' in status, false)
})

test('status does not claim an adapter credential that this plugin does not own', async () => {
  const controller = controllerWith({
    credentials: {
      readRecord: async (key: string) => key === ADAPTER_KEY
        ? { kind: 'grant', payload: { access: 'external-access' } }
        : undefined,
    },
  })

  assert.deepEqual(await controller.status(), { configured: false, ready: true })
})

test('syncModels adopts live models while preserving local model entries and edits', async () => {
  const previousManaged = [
    { id: 'old', name: 'Old' },
    { id: 'edited', name: 'Managed name' },
  ]
  const records: Record<string, StoredRecord | undefined> = {
    [MAIN_KEY]: { kind: 'grant', payload: { managedModels: previousManaged } },
    [ADAPTER_KEY]: {
      kind: 'grant',
      payload: { type: 'oauth', access: 'access-token', accountId: 'workspace-id' },
    },
  }
  const mutations: unknown[][] = []
  const controller = controllerWith({
    credentials: {
      readRecord: async (key: string) => records[key],
      modifyRecord: async (
        key: string,
        modify: (current: StoredRecord | undefined) => Promise<StoredRecord | undefined>,
      ) => { records[key] = await modify(records[key]) },
    },
    llm: {
      discoverModels: async () => [{ id: 'builtin-only' }, { id: 'new' }, { id: 'hidden-upstream' }],
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: 3,
        user: {
          providers: {
            'openai-codex': {
              models: [
                { id: 'old', name: 'Old' },
                { id: 'edited', name: 'Local name' },
                { id: 'custom' },
              ],
            },
          },
        },
        // Resolved values may contain schema defaults and must not be used as E.
        value: {
          providers: {
            'openai-codex': {
              models: [
                { id: 'old', name: 'Old', input: [] },
                { id: 'edited', name: 'Local name', input: [] },
                { id: 'custom', input: [] },
              ],
            },
          },
        },
      }],
      mutate: async (...args: unknown[]) => { mutations.push(args) },
    },
  })
  controller.modelDiscovery = async (credential) => {
    assert.deepEqual(credential, { access: 'access-token', accountId: 'workspace-id' })
    return {
      models: [
        { id: 'new', name: 'New' },
        { id: 'edited', name: 'Updated managed name' },
      ],
      seenIds: ['new', 'edited', 'hidden-upstream'],
    }
  }

  assert.deepEqual(await controller.syncModels(), { synced: true, count: 4 })
  assert.deepEqual(mutations, [[
    'llm-pi-ai',
    [{
      op: 'set',
      path: ['providers', 'openai-codex', 'models'],
      value: [
        { id: 'new', name: 'New' },
        { id: 'edited', name: 'Local name' },
        { id: 'builtin-only' },
        { id: 'custom' },
      ],
    }],
    3,
  ]])
  assert.deepEqual(records[MAIN_KEY]?.payload.managedModels, [
    { id: 'new', name: 'New' },
    { id: 'edited', name: 'Updated managed name' },
    { id: 'builtin-only' },
  ])
  assert.deepEqual(records[MAIN_KEY]?.payload.suppressedModelIds, [])
})

test('authorization refresh preserves model ownership metadata', async () => {
  const managedModels = [{ id: 'managed' }]
  const records: Record<string, StoredRecord | undefined> = {
    [MAIN_KEY]: {
      kind: 'grant',
      payload: {
        access: 'old-access',
        refresh: 'old-refresh',
        managedPiRoute: true,
        managedModels,
        suppressedModelIds: ['removed'],
        modelsSyncedAt: 123,
      },
    },
    [ADAPTER_KEY]: {
      kind: 'grant',
      payload: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', accountId: 'workspace-id' },
    },
  }
  const controller = controllerWith({
    credentials: {
      readRecord: async (key: string) => records[key],
      modifyRecord: async (
        key: string,
        modify: (current: StoredRecord | undefined) => Promise<StoredRecord | undefined>,
      ) => { records[key] = await modify(records[key]) },
    },
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => ({
        exitCode: 0,
        aborted: false,
        stdout: {
          text: JSON.stringify({
            type: 'result',
            credential: {
              access: 'new-access',
              refresh: 'new-refresh',
              expires: 2_000_000_000_000,
              accountId: 'workspace-id',
            },
          }),
        },
      }),
    },
  })
  controller.synchronizeModels = async () => ({ synced: true, count: 1 })
  const abort = new AbortController()

  await controller.runRefresh(
    { signal: abort.signal, aborted: () => abort.signal.aborted },
    () => {},
  )
  assert.deepEqual(records[MAIN_KEY]?.payload.managedModels, managedModels)
  assert.deepEqual(records[MAIN_KEY]?.payload.suppressedModelIds, ['removed'])
  assert.equal(records[MAIN_KEY]?.payload.modelsSyncedAt, 123)
  assert.equal(records[MAIN_KEY]?.payload.managedPiRoute, true)
  assert.equal(records[MAIN_KEY]?.payload.access, 'new-access')
})

test('automatic sync does not reinterpret a pre-existing user or base allow-list', async () => {
  for (const layer of ['user', 'base'] as const) {
    let mutated = false
    const route = { providers: { 'openai-codex': { models: [{ id: 'intentional-only' }] } } }
    const controller = controllerWith({
      credentials: {
        readRecord: async (key: string) => key === MAIN_KEY
          ? { kind: 'grant', payload: {} }
          : { kind: 'grant', payload: { access: 'access-token', accountId: 'workspace-id' } },
      },
      settings: {
        describe: () => [{ ns: 'llm-pi-ai', revision: 1, [layer]: route, value: route }],
        mutate: async () => { mutated = true },
      },
    })
    controller.modelDiscovery = async () => ({ models: [{ id: 'remote' }], seenIds: ['remote'] })

    await assert.rejects(controller.synchronizeModels(), /确认同步/)
    assert.equal(mutated, false)
  }
})

test('logout aborts and awaits an in-flight flow before deleting credentials', async () => {
  let finishTask!: () => void
  const task = new Promise<void>((resolve) => { finishTask = resolve })
  const flowController = new AbortController()
  const calls: string[] = []
  const controller = controllerWith({
    authorization: { cancel: () => calls.push('cancel-official') },
    credentials: {
      readRecord: async () => ({ kind: 'grant', payload: {} }),
      deleteRecord: async (key: string) => { calls.push('delete:' + key) },
    },
  })
  controller.pendingBridge = {
    notices: [],
    done: false,
    outcome: null,
    error: null,
    controller: flowController,
    task,
  }

  const logout = controller.logout()
  await Promise.resolve()
  assert.equal(flowController.signal.aborted, true)
  assert.deepEqual(calls, [])

  finishTask()
  await logout
  assert.deepEqual(calls, [
    'cancel-official',
    'delete:' + ADAPTER_KEY,
    'delete:' + MAIN_KEY,
  ])
})

test('logout cancels and awaits a standalone model sync before deleting credentials', async () => {
  const calls: string[] = []
  const syncController = new AbortController()
  const syncTask = new Promise<{ synced: true; count: number }>((resolve) => {
    syncController.signal.addEventListener('abort', () => resolve({ synced: true, count: 0 }), { once: true })
  })
  const controller = controllerWith({
    credentials: {
      readRecord: async () => ({ kind: 'grant', payload: {} }),
      deleteRecord: async (key: string) => { calls.push(key) },
    },
  })
  controller.modelSyncController = syncController
  controller.syncingModels = syncTask

  await controller.logout()
  assert.equal(syncController.signal.aborted, true)
  assert.deepEqual(calls, [ADAPTER_KEY, MAIN_KEY])
})

test('logout fails when the provider credential cannot be deleted', async () => {
  const calls: string[] = []
  const controller = controllerWith({
    credentials: {
      readRecord: async () => ({ kind: 'grant', payload: {} }),
      deleteRecord: async (key: string) => {
        calls.push(key)
        if (key === ADAPTER_KEY) throw new Error('locked')
      },
    },
  })

  await assert.rejects(controller.logout(), /locked/)
  assert.deepEqual(calls, [ADAPTER_KEY])
})

test('logout strips the duplicate token before a provider deletion that may fail', async () => {
  const records: Record<string, StoredRecord | undefined> = {
    [MAIN_KEY]: { kind: 'grant', payload: { access: 'secret', refresh: 'refresh-secret' } },
  }
  const controller = controllerWith({
    credentials: {
      readRecord: async (key: string) => records[key],
      modifyRecord: async (
        key: string,
        modify: (current: StoredRecord | undefined) => Promise<StoredRecord | undefined>,
      ) => { records[key] = await modify(records[key]) },
      deleteRecord: async (key: string) => {
        if (key === ADAPTER_KEY) throw new Error('locked')
        records[key] = undefined
      },
    },
  })

  await assert.rejects(controller.logout(), /locked/)
  assert.deepEqual(records[MAIN_KEY], {
    kind: 'grant',
    payload: { provider: 'openai', cleanupPending: true },
  })
})

test('logout removes an owned empty route using the current settings revision', async () => {
  const mutations: unknown[][] = []
  const controller = controllerWith({
    credentials: {
      readRecord: async () => ({ kind: 'grant', payload: { managedPiRoute: true } }),
      deleteRecord: async () => {},
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: 7,
        user: { providers: { 'openai-codex': {} } },
      }],
      mutate: async (...args: unknown[]) => { mutations.push(args) },
    },
  })

  await controller.logout()
  assert.deepEqual(mutations, [[
    'llm-pi-ai',
    [{ op: 'unset', path: ['providers', 'openai-codex'] }],
    7,
  ]])
})

test('logout retries settings conflicts before deleting either credential', async () => {
  let revision = 4
  const mutationRevisions: number[] = []
  const calls: string[] = []
  const managedModels = [{ id: 'managed' }]
  const controller = controllerWith({
    credentials: {
      readRecord: async () => ({ kind: 'grant', payload: { managedModels } }),
      deleteRecord: async (key: string) => { calls.push(key) },
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision,
        user: { providers: { 'openai-codex': { models: managedModels } } },
      }],
      mutate: async (_namespace: string, _operations: unknown[], expectedRevision: number) => {
        mutationRevisions.push(expectedRevision)
        if (mutationRevisions.length < 3) {
          revision += 1
          throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
        }
      },
    },
  })

  await controller.logout()
  assert.deepEqual(mutationRevisions, [4, 5, 6])
  assert.deepEqual(calls, [ADAPTER_KEY, MAIN_KEY])
})

test('logout preserves credentials when settings cleanup keeps conflicting', async () => {
  const calls: string[] = []
  const managedModels = [{ id: 'managed' }]
  const controller = controllerWith({
    credentials: {
      readRecord: async () => ({ kind: 'grant', payload: { managedModels } }),
      deleteRecord: async (key: string) => { calls.push(key) },
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: 1,
        user: { providers: { 'openai-codex': { models: managedModels } } },
      }],
      mutate: async () => { throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' }) },
    },
  })

  await assert.rejects(controller.logout(), /尚未断开连接/)
  assert.deepEqual(calls, [])
})

test('logout removes a plugin-created route after its model list was reset', async () => {
  const mutations: unknown[][] = []
  const controller = controllerWith({
    credentials: {
      readRecord: async () => ({
        kind: 'grant',
        payload: { managedPiRoute: true, managedModels: [{ id: 'managed' }] },
      }),
      deleteRecord: async () => {},
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: 8,
        user: { providers: { 'openai-codex': { models: [] } } },
      }],
      mutate: async (...args: unknown[]) => { mutations.push(args) },
    },
  })

  await controller.logout()
  assert.deepEqual(mutations, [[
    'llm-pi-ai',
    [{ op: 'unset', path: ['providers', 'openai-codex'] }],
    8,
  ]])
})

test('logout removes unchanged synced rows but preserves custom models and profile fields', async () => {
  const managedModels = [
    { id: 'managed', name: 'Managed' },
    { id: 'edited', name: 'Original' },
  ]
  const mutations: unknown[][] = []
  const controller = controllerWith({
    credentials: {
      readRecord: async (key: string) => key === MAIN_KEY
        ? { kind: 'grant', payload: { managedPiRoute: true, managedModels } }
        : undefined,
      deleteRecord: async () => {},
    },
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: 9,
        user: {
          providers: {
            'openai-codex': {
              transport: 'sse',
              models: [
                { id: 'managed', name: 'Managed' },
                { id: 'edited', name: 'Local edit' },
                { id: 'custom' },
              ],
            },
          },
        },
      }],
      mutate: async (...args: unknown[]) => { mutations.push(args) },
    },
  })

  await controller.logout()
  assert.deepEqual(mutations, [[
    'llm-pi-ai',
    [{
      op: 'set',
      path: ['providers', 'openai-codex', 'models'],
      value: [{ id: 'edited', name: 'Local edit' }, { id: 'custom' }],
    }],
    9,
  ]])
})
