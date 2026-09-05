import assert from 'node:assert/strict'
import test from 'node:test'

import OpenAISubscriptionController from '../src/host.js'

const MAIN_KEY = 'dsh-openai-subscription/chatgpt'
const ADAPTER_KEY = 'llm-pi-ai/openai-codex'

function controllerWith(services) {
  const controller = Object.create(OpenAISubscriptionController.prototype)
  controller.ctx = { get: (name) => services[name] }
  controller.registeredAuthorization = null
  controller.cachedModule = '/trusted/openai-codex.js'
  controller.locatingModule = null
  controller.pendingBridge = null
  return controller
}

test('status reads tokens from the provider record and metadata from the plugin record', async () => {
  const records = {
    [MAIN_KEY]: {
      kind: 'grant',
      payload: { accountId: 'stale-account', expires: 1, refresh: 'stale-refresh', loginMethod: 'device_code' },
    },
    [ADAPTER_KEY]: {
      kind: 'grant',
      payload: { type: 'oauth', access: 'live-access', refresh: 'live-refresh', expires: 2_000_000_000_000, accountId: 'live-account' },
    },
  }
  const controller = controllerWith({
    credentials: { readRecord: async (key) => records[key] },
  })

  assert.deepEqual(await controller.status(), {
    configured: true,
    ready: true,
    accountId: 'live-account',
    expires: 2_000_000_000_000,
    loginMethod: 'device_code',
    obtainedAt: null,
    refreshedAt: null,
    hasRefresh: true,
  })
})

test('logout aborts and awaits an in-flight flow before deleting credentials', async () => {
  let finishTask
  const task = new Promise((resolve) => { finishTask = resolve })
  const flowController = new AbortController()
  const calls = []
  const controller = controllerWith({
    authorization: { cancel: () => calls.push('cancel-official') },
    credentials: {
      readRecord: async () => ({ kind: 'grant', payload: {} }),
      deleteRecord: async (key) => { calls.push('delete:' + key) },
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

test('logout fails when the provider credential cannot be deleted', async () => {
  const calls = []
  const controller = controllerWith({
    credentials: {
      readRecord: async () => ({ kind: 'grant', payload: {} }),
      deleteRecord: async (key) => {
        calls.push(key)
        if (key === ADAPTER_KEY) throw new Error('locked')
      },
    },
  })

  await assert.rejects(controller.logout(), /locked/)
  assert.deepEqual(calls, [ADAPTER_KEY])
})

test('logout removes an owned empty route using the current settings revision', async () => {
  const mutations = []
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
      mutate: async (...args) => { mutations.push(args) },
    },
  })

  await controller.logout()
  assert.deepEqual(mutations, [[
    'llm-pi-ai',
    [{ op: 'unset', path: ['providers', 'openai-codex'] }],
    7,
  ]])
})
