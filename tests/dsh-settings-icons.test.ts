import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

type Parse = (source: string, options: { sourceType: string }) => unknown
interface PatchAPI {
  PATHS: Record<string, string>
  sha256(value: string): string
  replaceOnce(source: string, before: string, after: string): string
  patchSlotTypes(source: string): string
  patchSlotRuntime(source: string): string
  patchSettingsClient(source: string): string
  patchBundledSlotCore(source: string, parse: Parse): string
  locateBundledSlotCore(source: string, parse: Parse): { node: { start: number; end: number } }
  loadToolchain(root: string): {
    parse: Parse
    transform(source: string, options: object): Promise<{ code: string }>
  }
  run(options: { root: string; action: string; backupDir?: string }): Promise<unknown>
}
const patch = await import(pathToFileURL(resolve('scripts/patch-dsh-settings-icons.mjs')).href) as PatchAPI

test('DSH patch anchors fail closed on missing, duplicate, or already-patched input', () => {
  assert.equal(patch.replaceOnce('before', 'before', 'after'), 'after')
  assert.throws(() => patch.replaceOnce('wrong', 'before', 'after'), /exactly one/)
  assert.throws(() => patch.replaceOnce('before before', 'before', 'after'), /exactly one/)
  const source = '...options.label !== void 0 ? { label: options.label } : {},'
  assert.throws(() => patch.patchSettingsClient('unrecognized upstream renderer'), /exactly one/)
  assert.match(patch.patchSlotRuntime(source), /typeof options.icon === "function"/)
  assert.throws(() => patch.patchSlotRuntime(patch.patchSlotRuntime(source)), /duplicate patch/)
})

test('DSH SlotIcon type is optional, framework-neutral, and keeps labels string-only', () => {
  const result = patch.patchSlotTypes(`export type SlotLabel = string | (() => string);
type List = {
    label?: SlotLabel;
    /** Cell shadowing rank */
};
interface StoredEntry {
    options: {
        label?: SlotLabel;
        priority?: number;
    };
}`)
  assert.match(result, /SlotIcon = \(props: \{ size: number; className\?: string \}\) => unknown/)
  assert.equal(result.match(/icon\?: SlotIcon/g)?.length, 2)
  assert.match(result, /SlotLabel = string \| \(\(\) => string\)/)
  assert.doesNotMatch(result, /ReactNode/)
  assert.throws(() => patch.patchSlotTypes(result), /exactly one/)
})

test('DSH stored metadata preserves icon identity without invoking it or changing labels', () => {
  const source = `function store(options) { return {
...options.label !== void 0 ? { label: options.label } : {},
}; }; store`
  const store = runInNewContext(patch.patchSlotRuntime(source)) as (options: object) => { label?: unknown; icon?: unknown }
  let calls = 0
  const icon = () => { calls += 1; return null }
  const label = () => 'ChatGPT Subscription'
  const stored = store({ label, icon })
  assert.equal(stored.icon, icon)
  assert.equal(stored.label, label)
  assert.equal(calls, 0)
  for (const invalid of [undefined, null, 'OpenAI', 42, {}]) assert.equal(store({ icon: invalid }).icon, undefined)
  assert.equal(Object.hasOwn(store({ label: 'Models' }), 'icon'), false)
})

test('DSH nav custom icon receives 16px/className while all existing fallbacks remain', () => {
  const source = `
const SettingsRoot_module_css_default = {navIcon: 'nav-class'};
const _deepseek_ai_dsh_client_ui_slots = {resolveSlotLabel: label => typeof label === 'function' ? label() : label};
function navIcon(id) {
  if (id === 'models') return 'data';
  if (id === 'agent-presets') return 'agent';
  if (id === 'plugins') return 'plugins';
  return 'gear';
}
function project(e) { return {
label: (0, _deepseek_ai_dsh_client_ui_slots.resolveSlotLabel)(e.options.label) ?? ""
}; }
function render(row) { return {children: [navIcon(row.id), row.label]}; }
({project, render})`
  const host = runInNewContext(patch.patchSettingsClient(source)) as {
    project(entry: object): { label: string; icon?: unknown }
    render(row: object): { children: unknown[] }
  }
  let language = 'en'
  const received: { size: number; className?: string }[] = []
  const icon = (value: { size: number; className?: string }) => { received.push(value); return 'openai-svg' }
  const entry = { options: { label: () => language === 'en' ? 'ChatGPT Subscription' : 'ChatGPT 订阅', icon } }
  assert.equal(host.project(entry).icon, icon)
  assert.equal(received.length, 0, 'projecting metadata must not render the callback')
  const row = host.project(entry)
  assert.equal(host.render({ id: 'openai-subscription', ...row }).children[0], 'openai-svg')
  assert.equal(received[0]?.size, 16)
  assert.equal(received[0]?.className, 'nav-class')
  language = 'zh'
  assert.equal(host.project(entry).label, 'ChatGPT 订阅')
  for (const [id, fallback] of [['models', 'data'], ['agent-presets', 'agent'], ['plugins', 'plugins'], ['general', 'gear'], ['unknown', 'gear']]) {
    assert.equal(host.render({ id, label: id }).children[0], fallback)
    assert.equal(host.render({ id, icon: 'invalid', label: id }).children[0], fallback)
  }
})

test('DSH patch rejects unknown installation versions before creating backups or modifying files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-icon-version-'))
  try {
    const packagePath = join(directory, 'node_modules/@deepseek-ai/dsh-client-ui-slots')
    mkdirSync(packagePath, { recursive: true })
    const manifest = '{"version":"999.0.0"}'
    writeFileSync(join(packagePath, 'package.json'), manifest)
    const backupDir = join(directory, 'backup')
    await assert.rejects(patch.run({ root: directory, action: 'apply', backupDir }), /expected .*999\.0\.0/)
    assert.equal(existsSync(backupDir), false)
    assert.equal(readFileSync(join(packagePath, 'package.json'), 'utf8'), manifest)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

// Opt-in real-artifact checks do not assume a developer's global installation.
// DSH_ICON_PATCH_TEST_ROOT=/path/to/dsh node --test .test-dist/tests/dsh-settings-icons.test.js
// On a patched installation, inspect only the pristine source backups made by this script.
const root = process.env.DSH_ICON_PATCH_TEST_ROOT
function hostSource(name: string): string {
  assert.ok(root)
  const relative = patch.PATHS[name]
  assert.ok(relative)
  const originals = join(homedir(), '.cache/dsh-settings-icons', patch.sha256(resolve(root)).slice(0, 16), 'v1/originals', relative)
  return readFileSync(existsSync(originals) ? originals : join(root, relative), 'utf8')
}

test('guarded host patch applies idempotently, preserves originals, and restores a disposable installation', { skip: !root }, async () => {
  assert.ok(root)
  const directory = mkdtempSync(join(tmpdir(), 'dsh-icon-transaction-'))
  const backupDir = join(directory, 'backups')
  try {
    for (const name of ['dsh-client-ui-slots', 'dsh-client-ui-settings-general', 'dsh-client-ui-settings', 'dsh-web-frontend']) {
      const relative = `node_modules/@deepseek-ai/${name}/package.json`
      const path = join(directory, relative)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, readFileSync(join(root, relative)))
    }
    for (const [key, relative] of Object.entries(patch.PATHS)) {
      const path = join(directory, relative)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, hostSource(key))
    }
    // Only read-only build dependencies are linked, never mutable DSH packages.
    mkdirSync(join(directory, 'node_modules/@babel'), { recursive: true })
    for (const name of ['esbuild', '@babel/parser']) {
      symlinkSync(join(root, 'node_modules', name), join(directory, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
    }
    const checked = await patch.run({ root: directory, action: 'check', backupDir }) as { status: string }
    assert.equal(checked.status, 'ready')
    assert.equal(existsSync(backupDir), false)
    const applied = await patch.run({ root: directory, action: 'apply', backupDir }) as { status: string; entryPath: string }
    assert.equal(applied.status, 'applied')
    assert.equal(readFileSync(join(directory, patch.PATHS.entry as string), 'utf8'), hostSource('entry'))
    assert.match(readFileSync(join(directory, patch.PATHS.html as string), 'utf8'), /index-settings-icons-[a-f0-9]{16}\.js/)
    assert.ok(existsSync(join(directory, applied.entryPath)))
    for (const [key, relative] of Object.entries(patch.PATHS)) assert.equal(readFileSync(join(backupDir, 'originals', relative), 'utf8'), hostSource(key))
    const repeated = await patch.run({ root: directory, action: 'apply', backupDir }) as { status: string }
    assert.equal(repeated.status, 'already-applied')
    const settingsPath = join(directory, patch.PATHS.settings as string)
    const settings = readFileSync(settingsPath, 'utf8')
    writeFileSync(settingsPath, settings + '\n// unrelated change\n')
    await assert.rejects(patch.run({ root: directory, action: 'restore', backupDir }), /Patched file changed/)
    assert.ok(existsSync(join(directory, applied.entryPath)), 'failed restore must not partially remove artifacts')
    writeFileSync(settingsPath, settings)
    const restored = await patch.run({ root: directory, action: 'restore', backupDir }) as { status: string }
    assert.equal(restored.status, 'restored')
    assert.equal(existsSync(join(directory, applied.entryPath)), false)
    for (const [key, relative] of Object.entries(patch.PATHS)) assert.equal(readFileSync(join(directory, relative), 'utf8'), hostSource(key))
    assert.ok(existsSync(join(backupDir, 'originals', patch.PATHS.entry as string)))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('installed Web SlotCore survives parsed insertion and esbuild regeneration', { skip: !root }, async () => {
  assert.ok(root)
  const { parse, transform } = patch.loadToolchain(root)
  const original = hostSource('entry')
  const patched = patch.patchBundledSlotCore(original, parse)
  assert.throws(() => patch.patchBundledSlotCore(patched, parse), /pristine stored-options/)
  const rebuilt = await transform(patched, { loader: 'js', format: 'esm', target: 'esnext', minify: true })
  for (const source of [patched, rebuilt.code]) {
    const { node } = patch.locateBundledSlotCore(source, parse)
    const classSource = source.slice(node.start, node.end)
    // The class's only nonstandard external is its frozen empty-entries singleton.
    const singleton = /entries:\s*([A-Za-z_$][\w$]*)/.exec(classSource)?.[1]
    assert.ok(singleton)
    const Core = runInNewContext(`(${classSource})`, {
      [singleton]: Object.freeze([]), queueMicrotask: () => {},
    }) as new () => {
      register(options: object, component: () => null): () => void
      entries(name: string): { options: { icon?: unknown; label?: string } }[]
      snapshot(name: string): unknown
    }
    const core = new Core()
    core.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, () => null)
    const icon = () => 'svg'
    const dispose = core.register({ name: 'settings.section', id: 'openai-subscription', label: 'ChatGPT', icon }, () => null)
    assert.equal(core.entries('settings.section')[0]?.options.icon, icon)
    assert.equal(core.entries('settings.section')[0]?.options.label, 'ChatGPT')
    assert.doesNotMatch(JSON.stringify(core.snapshot('settings.section')), /icon/)
    dispose()
    assert.equal(core.entries('settings.section').length, 0)
  }
})

test('installed settings client projects icon metadata and renders existing primitives unchanged', { skip: !root }, () => {
  const source = patch.patchSettingsClient(hostSource('settings'))
  const instrumented = source.replace('exports.apply = apply;', 'exports.apply = apply; exports.testNavIcon = navIcon;')
  let factory: ((require: (name: string) => unknown) => Record<string, unknown>) | undefined
  runInNewContext(instrumented, { window: { __ModuleLoader__: { load: (registration: { factory: typeof factory }) => { factory = registration.factory } } } })
  assert.ok(factory)
  const primitiveNames = ['IconDataOutline16', 'IconAgentPresetOutline16', 'IconPersonalizationOutline16', 'IconSettingsOutline16']
  const primitives = Object.fromEntries(primitiveNames.map((name) => [name, name]))
  const jsx = (type: unknown, props: object) => ({ type, props })
  const exports = factory((name) => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (name === '@deepseek-ai/dsh-client-ui-slots') return { resolveSlotLabel: (label: unknown) => typeof label === 'function' ? label() : label }
    return {}
  })
  let label = 'ChatGPT Subscription'
  const icon = (props: object) => ({ type: 'svg', props })
  const registrations = new Map<string, { name?: string; inject?: () => { hooks: { sections: { getSnapshot(): { icon?: unknown; label: string }[] } } } }>()
  const apply = exports.apply as (ctx: object) => void
  apply({
    effect: (setup: () => unknown) => setup(), get: () => ({}),
    remote: { $host: { isLoopback: false } },
    locale: { register: () => () => {}, bind: () => (key: string) => key, getSnapshot: () => ({ revision: label.length }) },
    slots: {
      inject: (_name: string, setup: () => unknown) => setup(),
      register: (options: { name: string }) => { registrations.set(options.name, options); return () => {} },
      getVersion: () => 1,
      entries: () => [{ options: { id: 'openai-subscription', order: 25, label: () => label, icon } }],
    },
  })
  const sections = registrations.get('sidebar.settings')?.inject?.().hooks.sections
  assert.ok(sections)
  assert.equal(sections.getSnapshot()[0]?.icon, icon)
  assert.equal(sections.getSnapshot()[0]?.label, label)
  label = 'ChatGPT 订阅'
  assert.equal(sections.getSnapshot()[0]?.label, label)
  const navIcon = exports.testNavIcon as (id: string, icon?: unknown) => { type: string; props: { size: number; className: string } }
  const custom = navIcon('openai-subscription', icon)
  assert.equal(custom.type, 'svg')
  assert.equal(custom.props.size, 16)
  assert.ok(custom.props.className)
  for (const [id, expected] of [['models', primitiveNames[0]], ['agent-presets', primitiveNames[1]], ['plugins', primitiveNames[2]], ['general', primitiveNames[3]], ['unknown', primitiveNames[3]]]) {
    assert.equal(navIcon(id as string).type, expected)
    assert.equal(navIcon(id as string, 'invalid').type, expected)
  }
})
