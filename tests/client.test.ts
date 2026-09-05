import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createContext, Script } from 'node:vm'

// A dependency-free hook/DOM harness: execute the real global loader script,
// commit refs before effects, reconcile nodes, and drive RPC/timers/user events.
const clientSource = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
type Props = Record<string, unknown>
interface ElementNode { type: string | ((props: Props) => ElementNode); props: Props; children: unknown[] }
interface Registration {
  id: string
  factory(require: (id: string) => unknown): { apply(ctx: Props): void; inject: string[] }
}
interface EffectSlot { deps?: readonly unknown[]; cleanup?: () => void }
interface RpcReply { ok: boolean; value?: unknown; error?: unknown }
type Handler = (args: Props, signal: AbortSignal) => RpcReply | Promise<RpcReply>
const ok = (value: unknown): RpcReply => ({ ok: true, value })
const connected = { configured: true, ready: true, refreshable: true, modelsSynced: true, modelCount: 3, credentialState: 'valid', cleanupAvailable: true, flowPending: false }
const disconnected = { ...connected, configured: false, refreshable: false, modelsSynced: false, modelCount: 0, cleanupAvailable: false }
const deviceNotice = { kind: 'enter-code', code: 'ABCD-EFGH', url: 'https://auth.openai.com/codex/device' }

class FakeNode {
  props: Props = {}
  children: FakeNode[] = []
  isConnected = true
  selected = false
  textContent = ''
  constructor(readonly tag: string, readonly document: FakeDocument) {}
  get disabled(): boolean { return this.props.disabled === true }
  focus(): void {
    if (this.disabled || !this.isConnected || this.document.activeElement === this) return
    this.document.activeElement = this
    this.document.dispatch('focusin', { target: this })
    const handler = this.props.onFocus as ((event: unknown) => void) | undefined
    handler?.({ currentTarget: this })
  }
  select(): void { this.selected = true }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)) }
  matches(selector: string): boolean { return selector === ':disabled' && this.disabled }
  setAttribute(): void {}
  querySelectorAll(): FakeNode[] {
    return this.children.flatMap((child) => [
      ...((child.tag === 'button' || child.tag === 'input' || child.props.href || child.props.tabIndex === 0) && !child.disabled ? [child] : []),
      ...child.querySelectorAll(),
    ])
  }
}
class FakeDocument {
  activeElement: FakeNode | null = null
  listeners = new Map<string, Set<(event: never) => void>>()
  styleAdded = false
  styles: FakeNode[] = []
  head = { appendChild: (node: FakeNode) => { this.styleAdded = true; this.styles.push(node) } }
  querySelector(): null { return null }
  createElement(tag: string): FakeNode { return new FakeNode(tag, this) }
  addEventListener(name: string, callback: (event: never) => void): void {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(callback)
    this.listeners.set(name, listeners)
  }
  removeEventListener(name: string, callback: (event: never) => void): void { this.listeners.get(name)?.delete(callback) }
  dispatch(name: string, event: unknown): void {
    for (const callback of this.listeners.get(name) ?? []) callback(event as never)
  }
  key(key: string, shiftKey = false): { prevented: boolean; stopped: boolean } {
    const event = { key, shiftKey, prevented: false, stopped: false,
      preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
    this.dispatch('keydown', event)
    return event
  }
}

class Harness {
  document = new FakeDocument()
  navigator: { language: string; clipboard?: { writeText: (text: string) => Promise<void> } }
  handlers: Partial<Record<string, Handler>> = {}
  calls: { method: string; args: Props; signal: AbortSignal }[] = []
  status: Props = { ...disconnected }
  snapshot: Props = { status: 'pending', notices: [deviceNotice], outcome: null }
  dictionaries: Record<string, Record<string, string>> = {}
  translatedKeys = new Set<string>()
  resets = new Set<() => void>()
  meta: Props = {}
  inject: string[] = []
  registrationId = ''
  tree!: ElementNode
  nodes = new Map<string, FakeNode>()
  now = 100_000
  timers = new Map<number, { at: number; delay: number; repeat: boolean; callback: () => void }>()
  private timerId = 0
  private states = new Map<number, unknown>()
  private refs = new Map<number, { current: unknown }>()
  private effects = new Map<number, EffectSlot>()
  private pendingEffects: { index: number; setup: () => void | (() => void); deps?: readonly unknown[] }[] = []
  private cursor = 0
  private dirty = true
  private mounted = true
  private component!: (props: Props) => ElementNode
  private props: Props = {}
  updatesAfterUnmount = 0

  constructor(readonly language = 'en', localeAvailable = true, configure?: (harness: Harness) => void) {
    this.navigator = { language }
    configure?.(this)
    const react = {
      createElement: (type: ElementNode['type'], props: Props | null, ...children: unknown[]): ElementNode => ({ type, props: props ?? {}, children }),
      useState: <T>(initial: T): [T, (update: T | ((previous: T) => T)) => void] => {
        const index = this.cursor++
        if (!this.states.has(index)) this.states.set(index, initial)
        return [this.states.get(index) as T, (update) => {
          if (!this.mounted) { this.updatesAfterUnmount += 1; return }
          const previous = this.states.get(index) as T
          const value = typeof update === 'function' ? (update as (previous: T) => T)(previous) : update
          if (!Object.is(previous, value)) { this.states.set(index, value); this.dirty = true }
        }]
      },
      useRef: <T>(initial: T): { current: T } => {
        const index = this.cursor++
        if (!this.refs.has(index)) this.refs.set(index, { current: initial })
        return this.refs.get(index) as { current: T }
      },
      useEffect: (setup: () => void | (() => void), deps?: readonly unknown[]) => {
        const index = this.cursor++
        const previous = this.effects.get(index)
        if (!previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
          this.pendingEffects.push({ index, setup, deps })
        }
      },
    }
    let registration: Registration | undefined
    const harness = this
    const context = createContext({
      window: { __ModuleLoader__: { load: (value: Registration) => { registration = value } } },
      document: this.document,
      navigator: this.navigator,
      URL, AbortController,
      Date: class extends Date { static override now(): number { return harness.now } },
      setTimeout: (callback: () => void, delay: number) => this.schedule(callback, delay, false),
      clearTimeout: (id: number) => this.timers.delete(id),
      setInterval: (callback: () => void, delay: number) => this.schedule(callback, delay, true),
      clearInterval: (id: number) => this.timers.delete(id),
      console: { warn: () => { throw new Error('Client must not log raw RPC diagnostics') } },
    })
    new Script(clientSource, { filename: 'client.js' }).runInContext(context)
    assert.ok(registration)
    this.registrationId = registration.id
    const plugin = registration.factory((id) => { assert.equal(id, 'react'); return react })
    this.inject = Array.from(plugin.inject)
    let sectionRender: (() => ElementNode) | undefined
    const slots = {
      inject: (name: string, setup: () => void) => { assert.equal(name, 'settings.section'); setup() },
      register: (meta: Props, render: () => ElementNode) => { this.meta = meta; sectionRender = render },
    }
    const locale = {
      register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => {
        assert.equal(namespace, 'settings.openaiSubscription')
        this.dictionaries = dictionaries
        return () => {}
      },
      bind: () => (key: string, params?: Record<string, string | number>) => this.translate(key, params),
    }
    plugin.apply({
      connection: { rpc: { call: async (route: string, method: string, payload: { args: Props }, signal: AbortSignal) => {
        assert.equal(route, '/api')
        const name = method.replace('openaiSubscription/', '')
        this.calls.push({ method: name, args: payload.args, signal })
        const handler = this.handlers[name]
        if (handler) return handler(payload.args, signal)
        if (name === 'status') return ok(this.status)
        if (name === 'poll') return ok(this.snapshot)
        if (name === 'authorize') return ok({ started: true })
        if (name === 'syncModels') return ok({ synced: true, count: 3 })
        return ok({})
      } } },
      timer: { interval: (callback: () => void, delay: number) => {
        const id = this.schedule(callback, delay, true)
        return () => { this.timers.delete(id) }
      } },
      locale: localeAvailable ? locale : undefined,
      get: (name: string) => name === 'slots' ? slots : name === 'locale' && localeAvailable ? locale : undefined,
      on: (name: string, callback: () => void) => {
        assert.equal(name, 'connection/reset')
        this.resets.add(callback)
        return () => { this.resets.delete(callback) }
      },
      effect: (setup: () => void) => setup(),
    })
    assert.ok(sectionRender)
    const element = sectionRender()
    assert.equal(typeof element.type, 'function')
    this.component = element.type as (props: Props) => ElementNode
    this.props = element.props
  }
  translate(key: string, params: Record<string, string | number> = {}): string {
    this.translatedKeys.add(key)
    const template = this.dictionaries[this.language]?.[key]
    assert.equal(typeof template, 'string', 'Missing translation: ' + key)
    return template!.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
  }
  private schedule(callback: () => void, delay: number, repeat: boolean): number {
    const id = ++this.timerId
    this.timers.set(id, { at: this.now + delay, delay, repeat, callback })
    return id
  }
  private render(): void {
    if (!this.dirty || !this.mounted) return
    this.dirty = false
    this.cursor = 0
    this.pendingEffects = []
    this.tree = this.component(this.props)
    const previousNodes = this.nodes
    const nextNodes = new Map<string, FakeNode>()
    const visit = (value: unknown, path: string): FakeNode[] => {
      if (Array.isArray(value)) return value.flatMap((child, i) => visit(child, path + '.' + i))
      if (value === null || typeof value !== 'object') return []
      const element = value as ElementNode
      // Nested presentational components (e.g. the shared brand SVG) have no hooks.
      if (typeof element.type === 'function') return visit(element.type(element.props), path + '.component')
      assert.equal(typeof element.type, 'string')
      const old = previousNodes.get(path)
      const node = old?.tag === element.type ? old : new FakeNode(element.type as string, this.document)
      node.props = element.props
      node.isConnected = true
      node.children = element.children.flatMap((child, i) => visit(child, path + '.' + i))
      node.textContent = this.text(element)
      nextNodes.set(path, node)
      const ref = element.props.ref as { current: FakeNode | null } | undefined
      if (ref) ref.current = node
      return [node]
    }
    visit(this.tree, 'root')
    for (const [path, node] of previousNodes) {
      if (nextNodes.get(path) !== node) {
        node.isConnected = false
        const ref = node.props.ref as { current: FakeNode | null } | undefined
        if (ref?.current === node) ref.current = null
      }
    }
    this.nodes = nextNodes
    for (const pending of this.pendingEffects) {
      this.effects.get(pending.index)?.cleanup?.()
      const cleanup = pending.setup()
      this.effects.set(pending.index, { deps: pending.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
    }
  }
  async flush(): Promise<void> {
    for (let i = 0; i < 30; i += 1) { this.render(); await Promise.resolve() }
  }
  async advance(ms: number): Promise<void> {
    await this.flush()
    const end = this.now + ms
    let iterations = 0
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      assert.ok(++iterations < 5000, 'Timer runaway')
      const [id, timer] = next
      this.now = timer.at
      if (timer.repeat) timer.at += timer.delay
      else this.timers.delete(id)
      timer.callback()
      await this.flush()
    }
    this.now = end
    await this.flush()
  }
  text(value: unknown = this.tree): string {
    if (value === null || value === undefined || typeof value === 'boolean') return ''
    if (Array.isArray(value)) return value.map((child) => this.text(child)).join(' ')
    if (typeof value !== 'object') return String(value)
    const element = value as ElementNode
    if (typeof element.type === 'function') return this.text(element.type(element.props))
    return element.children.map((child) => this.text(child)).join(' ')
  }
  all(tag: string): FakeNode[] { return [...this.nodes.values()].filter((node) => node.tag === tag) }
  button(label: string): FakeNode {
    const node = this.all('button').find((item) => item.textContent.trim() === label)
    assert.ok(node, 'Missing button: ' + label + '\n' + this.text())
    return node
  }
  async click(label: string): Promise<void> {
    const button = this.button(label)
    assert.equal(button.disabled, false, 'Disabled button: ' + label)
    button.focus()
    ;(button.props.onClick as () => void)()
    await this.flush()
  }
  async reset(): Promise<void> { for (const callback of this.resets) callback(); await this.flush() }
  dispose(): void {
    this.mounted = false
    for (const effect of this.effects.values()) effect.cleanup?.()
    for (const node of this.nodes.values()) node.isConnected = false
  }
}

async function mount(options: { language?: string; locale?: boolean; configure?: (harness: Harness) => void } = {}): Promise<Harness> {
  const harness = new Harness(options.language, options.locale, options.configure)
  await harness.flush()
  return harness
}

test('global loader registers settings and complete matching English/Chinese dictionaries', async () => {
  const h = await mount()
  try {
    assert.equal(h.registrationId, 'dsh-openai-subscription')
    assert.deepEqual(h.inject, ['connection', 'timer', 'slots', 'locale'])
    assert.equal(h.document.styleAdded, true)
    assert.equal(h.meta.id, 'openai-subscription')
    assert.equal(h.meta.locale, 'settings.openaiSubscription')
    assert.equal((h.meta.label as () => string)(), 'ChatGPT Subscription')
    const en = h.dictionaries.en!
    const zh = h.dictionaries.zh!
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
    for (const key of Object.keys(en)) {
      assert.ok(en[key]!.trim() && zh[key]!.trim(), key)
      assert.deepEqual(en[key]!.match(/\{\w+\}/g), zh[key]!.match(/\{\w+\}/g), key)
    }
    assert.equal(h.calls.filter((call) => call.method === 'poll').length, 0)
  } finally { h.dispose() }
})

test('header and navigation share a theme-aware OpenAI SVG without changing text labels', async () => {
  for (const language of ['en', 'zh']) {
    const h = await mount({ language })
    try {
      assert.equal((h.meta.label as () => string)(), h.translate('nav'))
      assert.equal(typeof h.meta.icon, 'function')
      const nav = (h.meta.icon as (props: Props) => ElementNode)({ size: 16, className: 'host-nav-icon' })
      assert.equal(nav.type, 'svg')
      assert.equal(nav.props.width, 16)
      assert.equal(nav.props.height, 16)
      assert.equal(nav.props.className, 'host-nav-icon')
      const [header] = h.all('svg')
      assert.ok(header)
      assert.equal(header.props.width, 24)
      assert.equal(header.props.height, 24)
      for (const props of [nav.props, header.props]) {
        assert.equal(props.viewBox, '0 0 24 24')
        assert.equal(props.fill, 'currentColor')
        assert.equal(props.fillRule, 'evenodd')
        assert.equal(props['aria-hidden'], true)
        assert.equal(props.focusable, false)
      }
      assert.equal((nav.children[0] as ElementNode).props.d, header.children[0]?.props.d)
      assert.equal(h.all('img').length, 0, 'Brand icon must not load an external image')
      assert.equal(h.text().includes('✦'), false)
    } finally { h.dispose() }
  }
})

test('outlined controls use visible full-pixel theme-aware borders without overriding filled hover colors', async () => {
  const h = await mount()
  try {
    const css = h.document.styles.map((style) => style.textContent).join('\n')
    const button = css.match(/\.oasub-button \{([^}]+)\}/)?.[1] ?? ''
    assert.match(button, /border: 1px solid var\(--oasub-control-border\)/)
    assert.match(css, /--oasub-control-border: color-mix\(in srgb, var\(--dsw-alias-label-primary, #0f1115\) 48%, transparent\)/)
    assert.match(css, /\.oasub-button:not\(\.primary\):not\(\.danger\):hover:not\(:disabled\)/)
    assert.doesNotMatch(css, /\.oasub-button:hover:not\(:disabled\) \{[^}]*background:/)
    assert.match(css, /\.oasub-button:focus-visible \{ outline: 2px solid/)
    assert.match(css, /@media \(forced-colors: active\)/)
    assert.match(css, /\.oasub-button:disabled \{ border-color: GrayText; color: GrayText; opacity: 1; \}/)
  } finally { h.dispose() }
})

test('header and reload footer stay flush with the card frame while only card content is inset', async () => {
  for (const status of [connected, disconnected]) {
    const h = await mount({ configure: (h) => { h.status = { ...status } } })
    try {
      const css = h.document.styles.map((style) => style.textContent).join('\n')
      assert.match(css, /--oasub-section-inset: 20px;/)
      assert.match(css, /--oasub-card-border-width: 1px;/)
      assert.match(css, /\.oasub-heading \{ min-width: 0; overflow-wrap: anywhere; \}/)
      assert.match(css, /\.oasub-header, \.oasub-footer \{ padding-inline: 0; \}/)
      assert.doesNotMatch(css, /\.oasub-header, \.oasub-footer \{[^}]*--oasub-section-inset/)
      const card = css.match(/\.oasub-card \{([^}]+)\}/)?.[1] ?? ''
      assert.match(card, /padding: var\(--oasub-section-inset\);/)
      assert.match(card, /border: var\(--oasub-card-border-width\) solid/)
      assert.match(css, /@media \(max-width: 520px\) \{\s*\.oasub-wrap \{ --oasub-section-inset: 16px; \}/)
      const footers = h.all('div').filter((node) => node.props.className === 'oasub-actions oasub-footer')
      assert.equal(footers.length, 1, 'Identify the standalone reload row separately from card/dialog actions')
      assert.equal(footers[0]?.children[0], h.button('Reload status'))
    } finally { h.dispose() }
  }
})

test('action error persists after automatic, manual, and connection-reset status reloads', async () => {
  const h = await mount({ configure: (h) => {
    h.status = { ...connected }
    h.handlers.syncModels = () => { throw new Error('[openai-subscription:settings-write-failed]') }
  } })
  try {
    await h.click('Update models')
    const message = h.translate('error.settings-write-failed')
    assert.ok(h.text().includes(message))
    assert.ok(h.calls.filter((call) => call.method === 'status').length >= 2)
    await h.click('Reload status')
    assert.ok(h.text().includes(message))
    await h.reset()
    assert.ok(h.text().includes(message))
    assert.equal(h.all('div').some((node) => node.props.role === 'alert' && node.textContent.includes(message)), true)
  } finally { h.dispose() }
})

const machineCodes = ['credentials-unavailable', 'shell-unavailable', 'timer-unavailable', 'component-unavailable', 'runtime-unsupported', 'busy', 'invalid-method', 'not-connected', 'not-refreshable', 'device-auth-disabled', 'access-denied', 'authorization-expired', 'rate-limited', 'network', 'timeout', 'invalid-response', 'process-exited', 'credential-write-failed', 'credential-changed', 'settings-unavailable', 'models-unavailable', 'models-empty', 'models-confirmation-required', 'settings-conflict', 'settings-write-failed', 'ownership-save-failed', 'cancelled', 'unknown']

test('all allowlisted authorize codes are localized without exposing raw diagnostics', async () => {
  for (const language of ['en', 'zh']) {
    for (const code of machineCodes) {
      const h = await mount({ language, configure: (h) => {
        h.handlers.authorize = () => ok({ started: false, errorCode: code, error: 'SECRET_DIAGNOSTIC' })
      } })
      try {
        await h.click(h.translate('action.connect'))
        assert.ok(h.text().includes(h.translate('error.' + code)), language + ':' + code)
        assert.equal(h.text().includes('SECRET_DIAGNOSTIC'), false)
      } finally { h.dispose() }
    }
  }
})

test('RPC failure envelopes recognize only exact allowlisted machine codes', async () => {
  const cases: { error: unknown; key: string }[] = [
    { error: { code: 'network', message: 'SECRET_TOKEN' }, key: 'error.network' },
    { error: { code: 'E_REMOTE', message: '[openai-subscription:access-denied]' }, key: 'error.access-denied' },
    { error: { message: '[openai-subscription:network] SECRET_TOKEN' }, key: 'error.start' },
    { error: { code: 'SECRET_TOKEN', message: '[openai-subscription:SECRET_TOKEN]' }, key: 'error.start' },
    { error: { message: 'network SECRET_TOKEN' }, key: 'error.start' },
  ]
  for (const item of cases) {
    const h = await mount({ configure: (h) => { h.handlers.authorize = () => ({ ok: false, error: item.error }) } })
    try {
      await h.click('Connect ChatGPT')
      assert.ok(h.text().includes(h.translate(item.key)))
      assert.equal(h.text().includes('SECRET_TOKEN'), false)
      assert.equal(h.calls.some((call) => call.method === 'cancel'), false)
    } finally { h.dispose() }
  }
})

test('unsafe verification URLs never become links and device progress is retained', async () => {
  for (const url of [
    'https://evil.example/codex/device', 'http://auth.openai.com/codex/device',
    'https://auth.openai.com.evil.example/codex/device', 'https://auth.openai.com@evil.example/codex/device',
    'https://evil:password@auth.openai.com/codex/device', 'https://auth.openai.com:444/codex/device',
    'https://auth.openai.com/codex/device?token=SECRET_TOKEN', 'https://auth.openai.com/codex/device#SECRET_TOKEN',
    'https://auth.openai.com/other', 'javascript:alert(1)', '//auth.openai.com/codex/device',
    'https://auth.openai.com/a/../codex/device', ' https://auth.openai.com/codex/device',
  ]) {
    const h = await mount({ configure: (h) => { h.snapshot = { status: 'pending', notices: [{ ...deviceNotice, url }] } } })
    try {
      await h.click('Connect ChatGPT')
      assert.equal(h.all('a').length, 0, url)
      assert.equal(h.all('input')[0]?.props.value, deviceNotice.code)
      assert.ok(h.text().includes(h.translate('error.unsafe-url')))
      assert.equal(h.text().includes('SECRET_TOKEN'), false)
    } finally { h.dispose() }
  }
})

test('safe verification is a native protected link; unavailable or rejected clipboard selects code', async () => {
  const h = await mount()
  try {
    await h.click('Connect ChatGPT')
    const link = h.all('a')[0]!
    assert.equal(link.props.href, deviceNotice.url)
    assert.equal(link.props.target, '_blank')
    assert.equal(link.props.rel, 'noopener noreferrer')
    assert.equal(link.props.onClick, undefined)
    assert.ok(String(link.props['aria-label']).includes('new tab'))
    await h.click('Copy code')
    assert.equal(h.all('input')[0]?.selected, true)
    assert.equal(h.all('input')[0]?.props.readOnly, true)
    assert.equal(h.document.activeElement, h.all('input')[0])
    assert.ok(h.text().includes('Ctrl+C'))
    h.navigator.clipboard = { writeText: async () => { throw new Error('SECRET_TOKEN') } }
    await h.click('Copy code')
    assert.ok(h.text().includes('Ctrl+C'))
    assert.equal(h.text().includes('SECRET_TOKEN'), false)
    let copied = ''
    h.navigator.clipboard = { writeText: async (code) => { copied = code } }
    await h.click('Copy code')
    assert.equal(copied, deviceNotice.code)
    assert.ok(h.text().includes('Code copied.'))
  } finally { h.dispose() }
})

test('idle poll does not fabricate authorization success for an already connected account', async () => {
  const h = await mount({ configure: (h) => { h.status = { ...connected }; h.snapshot = { status: 'idle', notices: [] } } })
  try {
    await h.click('Refresh authorization')
    assert.ok(h.text().includes(h.translate('error.poll-idle')))
    assert.equal(h.text().includes(h.translate('toast.connected')), false)
    const calls = h.calls.length
    await h.advance(60_000)
    assert.equal(h.calls.length, calls)
    await h.click('Cancel')
    assert.ok(h.text().includes(h.translate('toast.cancelled')))
    assert.equal(h.button('Refresh authorization').disabled, false)
  } finally { h.dispose() }
})

test('busy authorize does not replay a retained success from an unrelated operation', async () => {
  const h = await mount({ configure: (h) => {
    h.status = { ...connected }
    h.snapshot = { status: 'done', outcome: 'authorized', notices: [] }
    h.handlers.authorize = () => ok({ started: false, errorCode: 'busy' })
  } })
  try {
    await h.click('Refresh authorization')
    assert.ok(h.text().includes(h.translate('error.busy')))
    assert.equal(h.text().includes(h.translate('toast.connected')), false)
    assert.equal(h.calls.some((call) => call.method === 'poll'), false)
  } finally { h.dispose() }
})

test('uncertain start does not attribute a retained terminal success to a new attempt', async () => {
  const h = await mount({ configure: (h) => {
    h.handlers.authorize = () => new Promise(() => {})
    h.snapshot = { status: 'done', outcome: 'authorized', notices: [] }
  } })
  try {
    await h.click('Connect ChatGPT')
    await h.advance(15_000)
    await h.click('Retry authorization check')
    assert.ok(h.text().includes(h.translate('error.poll-unconfirmed')))
    assert.equal(h.text().includes(h.translate('toast.connected')), false)
    await h.click('Cancel')
    assert.equal(h.button('Connect ChatGPT').disabled, false)
    assert.ok(h.text().includes(h.translate('toast.cancelled')))
  } finally { h.dispose() }
})

test('poll failures back off, stop after four attempts, and explicit retry recovers snapshot', async () => {
  const h = await mount({ configure: (h) => { h.handlers.poll = () => { throw new Error('[openai-subscription:network]') } } })
  try {
    await h.click('Connect ChatGPT')
    await h.advance(7_000)
    assert.equal(h.calls.filter((call) => call.method === 'poll').length, 4)
    assert.ok(h.text().includes(h.translate('error.poll-paused')))
    await h.advance(60_000)
    assert.equal(h.calls.filter((call) => call.method === 'poll').length, 4)
    delete h.handlers.poll
    await h.click('Retry authorization check')
    assert.equal(h.all('input')[0]?.props.value, deviceNotice.code)
    assert.equal(h.text().includes(h.translate('error.poll-paused')), false)
    h.snapshot = { status: 'done', notices: [], outcome: 'authorized' }
    h.status = { ...connected }
    await h.advance(1_000)
    assert.ok(h.text().includes(h.translate('toast.connected')))
    assert.equal(h.all('input').length, 0)
  } finally { h.dispose() }
})

test('hung poll calls time out without overlapping and eventually pause', async () => {
  const h = await mount({ configure: (h) => { h.handlers.poll = () => new Promise(() => {}) } })
  try {
    await h.click('Connect ChatGPT')
    await h.advance(14_999)
    assert.equal(h.calls.filter((call) => call.method === 'poll').length, 1)
    await h.advance(52_001)
    const polls = h.calls.filter((call) => call.method === 'poll')
    assert.equal(polls.length, 4)
    assert.equal(polls.every((call) => call.signal.aborted), true)
    assert.ok(h.text().includes(h.translate('error.poll-paused')))
    await h.advance(60_000)
    assert.equal(h.calls.filter((call) => call.method === 'poll').length, 4)
  } finally { h.dispose() }
})

test('repeated pending notices never fabricate success and malformed device codes are not rendered', async () => {
  const h = await mount({ configure: (h) => {
    h.snapshot = { status: 'pending', notices: [deviceNotice, { kind: 'models-synced' }] }
  } })
  try {
    await h.click('Connect ChatGPT')
    await h.advance(3_000)
    assert.equal(h.text().includes(h.translate('toast.connected')), false)
    h.snapshot = { status: 'pending', notices: [{ ...deviceNotice, code: 'SECRET_TOKEN_WITH_DIAGNOSTICS: unauthorized' }] }
    await h.advance(1_000)
    assert.equal(h.all('input').length, 0)
    assert.equal(h.text().includes('SECRET_TOKEN'), false)
    assert.ok(h.text().includes(h.translate('error.invalid-response')))
  } finally { h.dispose() }
})

test('a successful pending snapshot cannot cause indefinite automatic polling', async () => {
  const h = await mount()
  try {
    await h.click('Connect ChatGPT')
    await h.advance(15 * 60_000)
    assert.ok(h.text().includes(h.translate('error.poll-paused')))
    const count = h.calls.length
    await h.advance(60_000)
    assert.equal(h.calls.length, count)
    assert.equal(h.all('input')[0]?.props.value, deviceNotice.code)
  } finally { h.dispose() }
})

test('initial flowPending resumes progress across remount without starting or cancelling login', async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const h = await mount({ configure: (h) => { h.status = { ...disconnected, flowPending: true } } })
    try {
      assert.equal(h.all('input')[0]?.props.value, deviceNotice.code)
      await h.click('Reload status')
      await h.reset()
      await h.advance(1_000)
      assert.equal(h.all('input')[0]?.props.value, deviceNotice.code)
      assert.equal(h.calls.some((call) => call.method === 'authorize' || call.method === 'cancel'), false)
    } finally { h.dispose() }
    await h.flush()
    assert.equal(h.updatesAfterUnmount, 0)
    assert.equal(h.timers.size, 0)
    assert.equal(h.resets.size, 0)
  }
})

test('status timeout exposes retry, clears only status feedback, and recovers pending authorization', async () => {
  const h = await mount({ configure: (h) => { h.handlers.status = () => new Promise(() => {}) } })
  try {
    await h.advance(15_000)
    assert.ok(h.text().includes(h.translate('error.timeout')))
    assert.equal(h.all('div').some((node) => String(node.props.className).includes('oasub-skeleton')), false)
    assert.equal(h.calls[0]?.signal.aborted, true)
    delete h.handlers.status
    h.status = { ...disconnected, flowPending: true }
    await h.click('Retry')
    assert.equal(h.text().includes(h.translate('error.timeout')), false)
    assert.equal(h.all('input')[0]?.props.value, deviceNotice.code)
  } finally { h.dispose() }
})

test('uncertain authorization timeout never implicitly cancels; manual poll can recover', async () => {
  const h = await mount({ configure: (h) => { h.handlers.authorize = () => new Promise(() => {}) } })
  try {
    await h.click('Connect ChatGPT')
    await h.advance(15_000)
    assert.ok(h.text().includes(h.translate('error.timeout')))
    assert.equal(h.calls.some((call) => call.method === 'cancel'), false)
    await h.click('Retry authorization check')
    assert.equal(h.all('input')[0]?.props.value, deviceNotice.code)
  } finally { h.dispose() }
})

test('terminal poll errors and model warnings use machine codes instead of raw messages', async () => {
  for (const outcome of ['failed', 'authorized']) {
    const h = await mount({ configure: (h) => {
      h.snapshot = { status: 'done', outcome, errorCode: 'credential-write-failed', error: 'SECRET_TOKEN', notices: [
        { kind: 'models-sync-failed', errorCode: 'ownership-save-failed', message: 'SECRET_TOKEN' },
      ] }
    } })
    try {
      await h.click('Connect ChatGPT')
      assert.ok(h.text().includes(h.translate(outcome === 'failed' ? 'error.credential-write-failed' : 'error.ownership-save-failed')))
      assert.equal(h.text().includes('SECRET_TOKEN'), false)
      const calls = h.calls.length
      await h.advance(5_000)
      assert.equal(h.calls.length, calls)
    } finally { h.dispose() }
  }
})

test('expired and unknown credentials never claim usable, and partial cleanup remains available', async () => {
  for (const state of ['expired', 'unknown']) {
    const h = await mount({ configure: (h) => { h.status = { ...connected, credentialState: state } } })
    try {
      assert.ok(h.text().includes(h.translate('status.' + state)))
      assert.equal(h.text().includes(h.translate('status.connected.detail')), false)
      assert.equal(h.button('Refresh authorization').disabled, false)
    } finally { h.dispose() }
  }
  const h = await mount({ configure: (h) => { h.status = { ...disconnected, ready: false, unavailableReason: 'shell-unavailable', cleanupAvailable: true } } })
  try {
    assert.ok(h.text().includes(h.translate('error.shell-unavailable')))
    assert.equal(h.button('Connect ChatGPT').disabled, true)
    assert.equal(h.button('Disconnect').disabled, false)
    await h.click('Disconnect')
    assert.ok([...h.nodes.values()].some((node) => node.props.role === 'dialog'))
  } finally { h.dispose() }
})

test('sync confirmation sends explicit consent and warning survives status reload', async () => {
  const h = await mount({ configure: (h) => {
    h.status = { ...connected, modelsSynced: false }
    h.handlers.syncModels = () => ok({ synced: true, count: 3, warningCode: 'ownership-save-failed', warning: 'SECRET_TOKEN' })
  } })
  try {
    await h.click('Sync models')
    assert.equal(h.calls.some((call) => call.method === 'syncModels'), false)
    await h.click('Confirm and sync')
    assert.equal(h.calls.find((call) => call.method === 'syncModels')?.args.confirmed, true)
    assert.ok(h.text().includes(h.translate('error.ownership-save-failed')))
    assert.equal(h.text().includes('SECRET_TOKEN'), false)
  } finally { h.dispose() }
})

test('unknown model warning codes produce generic warning, never raw text or false full success', async () => {
  const h = await mount({ configure: (h) => {
    h.status = { ...connected }
    h.handlers.syncModels = () => ok({ synced: true, count: 3, warningCode: 'SECRET_TOKEN' })
  } })
  try {
    await h.click('Update models')
    assert.ok(h.text().includes(h.translate('error.unknown')))
    assert.equal(h.text().includes('SECRET_TOKEN'), false)
    assert.equal(h.text().includes(h.translate('toast.synced', { count: 3 })), false)
  } finally { h.dispose() }
})

test('host confirmation requirement opens the dialog and never silently grants consent', async () => {
  let attempts = 0
  const h = await mount({ configure: (h) => {
    h.status = { ...connected }
    h.handlers.syncModels = (args) => {
      attempts += 1
      if (args.confirmed !== true) throw new Error('[openai-subscription:models-confirmation-required]')
      return ok({ synced: true, count: 3 })
    }
  } })
  try {
    await h.click('Update models')
    assert.equal(attempts, 1)
    assert.equal(h.document.activeElement, h.button('Cancel'))
    await h.click('Confirm and sync')
    assert.equal(attempts, 2)
    assert.ok(h.text().includes(h.translate('toast.synced', { count: 3 })))
  } finally { h.dispose() }
})

test('model sync and logout have a 75 second timeout and no automatic mutation retries', async () => {
  for (const method of ['syncModels', 'logout']) {
    const h = await mount({ configure: (h) => { h.status = { ...connected }; h.handlers[method] = () => new Promise(() => {}) } })
    try {
      if (method === 'syncModels') await h.click('Update models')
      else {
        await h.click('Disconnect')
        const dialog = [...h.nodes.values()].find((node) => node.props.role === 'dialog')!
        const confirmation = dialog.children.flatMap((node) => node.children).find((node) => node.tag === 'button' && node.textContent.trim() === 'Disconnect')!
        ;(confirmation.props.onClick as () => void)()
        await h.flush()
      }
      await h.advance(74_999)
      assert.equal(h.text().includes(h.translate('error.long-action')), false)
      await h.advance(1)
      assert.ok(h.text().includes(h.translate('error.long-action')))
      assert.equal(h.calls.find((call) => call.method === method)?.signal.aborted, true)
      await h.advance(90_000)
      assert.equal(h.calls.filter((call) => call.method === method).length, 1)
    } finally { h.dispose() }
  }
})

test('dialog focuses Cancel, traps Tab and escaped focus, and restores its trigger on Escape', async () => {
  const h = await mount({ configure: (h) => { h.status = { ...connected, modelsSynced: false } } })
  try {
    const trigger = h.button('Sync models')
    await h.click('Sync models')
    const dialog = [...h.nodes.values()].find((node) => node.props.role === 'dialog')!
    assert.equal(dialog.props['aria-modal'], true)
    assert.equal(dialog.props['aria-describedby'], 'oasub-dialog-detail')
    assert.equal(h.document.activeElement, h.button('Cancel'))
    assert.equal(h.document.key('Tab', true).prevented, true)
    assert.equal(h.document.activeElement, h.button('Confirm and sync'))
    assert.equal(h.document.key('Tab').prevented, true)
    assert.equal(h.document.activeElement, h.button('Cancel'))
    trigger.focus()
    assert.equal(h.document.activeElement, h.button('Cancel'))
    const escape = h.document.key('Escape')
    await h.flush()
    assert.equal(escape.prevented, true)
    assert.equal(escape.stopped, true)
    assert.equal(h.document.activeElement, trigger)
    assert.equal([...h.nodes.values()].some((node) => node.props.role === 'dialog'), false)
    assert.equal(h.document.listeners.get('keydown')?.size, 0)
    assert.equal(h.calls.some((call) => call.method === 'syncModels'), false)
  } finally { h.dispose() }
})

test('unmount aborts in-flight actions and prevents late state updates or implicit cancellation', async () => {
  let resolve: ((value: RpcReply) => void) | undefined
  const h = await mount({ configure: (h) => { h.handlers.authorize = () => new Promise((done) => { resolve = done }) } })
  await h.click('Connect ChatGPT')
  h.dispose()
  assert.equal(h.calls.find((call) => call.method === 'authorize')?.signal.aborted, true)
  resolve?.(ok({ started: true }))
  await h.flush()
  assert.equal(h.updatesAfterUnmount, 0)
  assert.equal(h.calls.some((call) => call.method === 'cancel' || call.method === 'poll'), false)
  assert.equal(h.timers.size, 0)
})

test('fallback localization uses browser English or Chinese without locale service', async () => {
  for (const language of ['en-US', 'zh-CN']) {
    const h = await mount({ language, locale: false })
    try {
      assert.ok(h.text().includes(language === 'zh-CN' ? '连接 ChatGPT' : 'Connect ChatGPT'))
      assert.equal(h.text().includes('status.disconnected'), false)
    } finally { h.dispose() }
  }
})
