import assert from 'node:assert/strict'
import test from 'node:test'

interface CapturedRegistration {
  id: string
  factory(require: (id: string) => unknown): {
    apply(ctx: Record<string, unknown>): void
    inject: string[]
  }
}

interface CapturedSection {
  meta: {
    name: string
    id: string
    order: number
    label: string | (() => string)
    locale?: string
  }
  render: () => unknown
}

test('client registers a localized settings section with required services', async () => {
  let registration: CapturedRegistration | undefined
  let appendedStyle = false
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __ModuleLoader__: {
        load(value: CapturedRegistration) { registration = value },
      },
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, textContent: '' }),
      head: { appendChild: () => { appendedStyle = true } },
    },
  })

  const clientModule = '../src/client.js'
  await import(clientModule)
  assert.equal(registration?.id, 'dsh-openai-subscription')

  const fakeReact = {
    createElement: (type: unknown, props: Record<string, unknown> | null) => ({ type, props, key: null }),
    useState: <T>(initial: T) => [initial, () => {}] as const,
    useEffect: () => {},
    useRef: <T>(initial: T) => ({ current: initial }),
  }
  const plugin = registration?.factory((id) => {
    assert.equal(id, 'react')
    return fakeReact
  })
  assert.ok(plugin)
  assert.deepEqual(plugin.inject, ['connection', 'timer', 'slots', 'locale'])

  let dictionaries: Record<string, Record<string, string>> | undefined
  let injection: (() => void) | undefined
  let section: CapturedSection | undefined
  const locale = {
    register: (_namespace: string, value: Record<string, Record<string, string>>) => {
      dictionaries = value
      return () => {}
    },
    bind: () => (key: string) => 'translated:' + key,
  }
  const slots = {
    inject: (name: string, setup: () => void) => {
      assert.equal(name, 'settings.section')
      injection = setup
    },
    register: (meta: CapturedSection['meta'], render: () => unknown) => {
      section = { meta, render }
    },
  }
  const connection = { rpc: { call: async () => ({ ok: true, value: {} }) } }
  plugin.apply({
    connection,
    timer: undefined,
    locale,
    get: (name: string) => name === 'slots' ? slots : name === 'locale' ? locale : undefined,
    effect: (setup: () => void) => setup(),
  })
  injection?.()

  assert.equal(appendedStyle, true)
  assert.ok(dictionaries?.zh)
  assert.ok(dictionaries?.en)
  assert.equal(section?.meta.id, 'openai-subscription')
  assert.equal(section?.meta.locale, 'settings.openaiSubscription')
  assert.equal(typeof section?.meta.label === 'function' ? section.meta.label() : section?.meta.label, 'translated:nav')
  const element = section?.render() as { props?: Record<string, unknown> } | undefined
  assert.equal(element?.props?.connection, connection)
  assert.equal(typeof element?.props?.t, 'function')

  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'document')
})
