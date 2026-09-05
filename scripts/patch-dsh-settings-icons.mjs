#!/usr/bin/env node
/**
 * Local DSH settings icon extension, v1. No server restart or DOM/CSS workaround.
 *
 * Usage (ROOT contains node_modules):
 *   node scripts/patch-dsh-settings-icons.mjs --root /path/to/dsh --check
 *   node scripts/patch-dsh-settings-icons.mjs --root /path/to/dsh --apply
 *   node scripts/patch-dsh-settings-icons.mjs --root /path/to/dsh --restore
 *
 * Requires @babel/parser and esbuild resolvable from ROOT (already present in
 * the tested installation). This is an exact-version AND SHA-256 guarded patch,
 * NOT a general updater: an upstream update must be reviewed before extending
 * the allowlist. No network, credential files, process discovery, or restarts.
 *
 * Originals and the integrity manifest live outside the project, by default in
 * ~/.cache/dsh-settings-icons/<installation-hash>/v1. --backup-dir overrides it.
 * All inputs are checked before writes; replaced files use atomic renames.
 * The original Web entry is kept, the parsed/rebuilt entry gets a new content-
 * addressed name, and index.html switches last. Refresh the existing DSH URL.
 * The host's client-hmr file poller must pick up the settings client.js change;
 * if disabled, arrange a host restart separately rather than restarting here.
 *
 * Contract: optional list metadata icon: SlotIcon, a pure renderer receiving
 * {size: number, className?: string} and returning the platform's render node.
 * The callback is not a component lifecycle boundary: do not use React hooks.
 * Labels stay strings, old registrants keep all their existing fallback icons.
 *
 * Small original-source anchors below are from DeepSeek Harness (MIT).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PATCH_ID = 'dsh-settings-icons-v1'
const PREFIX = 'node_modules/@deepseek-ai/'
export const PATHS = Object.freeze({
  slots: PREFIX + 'dsh-client-ui-slots/lib/index.js',
  slotTypes: PREFIX + 'dsh-client-ui-slots/lib/types/index.d.ts',
  settings: PREFIX + 'dsh-client-ui-settings-general/lib/client.js',
  rowTypes: PREFIX + 'dsh-client-ui-settings-general/lib/types/client/shell-contract.d.ts',
  contract: PREFIX + 'dsh-client-ui-settings/lib/types/client/contract/slots.d.ts',
  html: PREFIX + 'dsh-web-frontend/dist/index.html',
  entry: PREFIX + 'dsh-web-frontend/dist/assets/index-Df-65__b.js',
})
const HASHES = {
  slots: '88e637d250c130d3a0354f755dd16a6d01d56e7fe900d5b5e9f3ea149f340a46',
  slotTypes: 'af1cd9c1526fba74e9e012bf7edee8a51c75fe04ac5f1f218028795041ba9a2b',
  settings: '903bb84407104d5511f38eac13fc740ad147bab6a9c8d51bde52d90cfd996aff',
  rowTypes: '0af584ee896d66a85b91d3e69eb332fecacfb309928ecfe7e40b672973614c05',
  contract: '28f41cd0cfa460fb9ba97c9f2e51d6ce8b3c5a3ddd03835ec56505ac456f8495',
  html: 'cd1680663a395480e30f15f4ff9676d568b7c05b9c5fc7261535ce7ffe4d6dc2',
  entry: '9e845cbbe80482a49831d912b9c02324c5ff1e8c35b9cc5f7009ecbe6e4537c1',
}
const VERSIONS = {
  'dsh-client-ui-slots': '0.1.0-rc.7',
  'dsh-client-ui-settings-general': '0.1.2-rc.1',
  'dsh-client-ui-settings': '0.1.2-rc.1',
  'dsh-web-frontend': '0.1.2-rc.1',
}
export function sha256(value) { return createHash('sha256').update(value).digest('hex') }
export function replaceOnce(source, before, after, label = 'source anchor') {
  const index = source.indexOf(before)
  if (index < 0 || source.indexOf(before, index + before.length) !== -1) {
    throw new Error(`${label}: expected exactly one pristine match; refusing drift`)
  }
  return source.slice(0, index) + after + source.slice(index + before.length)
}
export function patchSlotTypes(source) {
  source = replaceOnce(source, 'export type SlotLabel = string | (() => string);', `export type SlotLabel = string | (() => string);
/** A pure platform-render callback for a list entry's decorative icon; no hooks. */
export type SlotIcon = (props: { size: number; className?: string }) => unknown;`, 'SlotLabel declaration')
  source = replaceOnce(source, '    label?: SlotLabel;\n    /** Cell shadowing rank', '    label?: SlotLabel;\n    /** Optional decorative icon; the rendering owner chooses its geometry. */\n    icon?: SlotIcon;\n    /** Cell shadowing rank', 'list icon declaration')
  return replaceOnce(source, '        label?: SlotLabel;\n        priority?: number;', '        label?: SlotLabel;\n        icon?: SlotIcon;\n        priority?: number;', 'stored icon declaration')
}
export function patchSlotRuntime(source) {
  if (source.includes('options.icon')) throw new Error('SlotCore icon field already present; refusing a duplicate patch')
  return replaceOnce(source,
    '...options.label !== void 0 ? { label: options.label } : {},',
    '...options.label !== void 0 ? { label: options.label } : {},\n\t\t\t\t...typeof options.icon === "function" ? { icon: options.icon } : {},', 'SlotCore stored options')
}
export function patchSettingsClient(source) {
  source = replaceOnce(source, 'function navIcon(id) {', `function navIcon(id, icon) {
			if (typeof icon === "function") return icon({ size: 16, className: SettingsRoot_module_css_default.navIcon });`, 'nav renderer')
  source = replaceOnce(source, 'children: [navIcon(row.id),', 'children: [navIcon(row.id, row.icon),', 'nav call')
  return replaceOnce(source, 'label: (0, _deepseek_ai_dsh_client_ui_slots.resolveSlotLabel)(e.options.label) ?? ""',
    'label: (0, _deepseek_ai_dsh_client_ui_slots.resolveSlotLabel)(e.options.label) ?? "",\n\t\t\t\t\t\t\t\t\t...typeof e.options.icon === "function" ? { icon: e.options.icon } : {}', 'settings row projection')
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'tokens' || key === 'comments') continue
    if (Array.isArray(value)) for (const child of value) walk(child, visit)
    else if (value && typeof value === 'object') walk(value, visit)
  }
}
function keyOf(node) { return node?.name ?? node?.value }
/** Identify the real bundled SlotCore by its methods AND registration invariant. */
export function locateBundledSlotCore(source, parse) {
  const ast = parse(source, { sourceType: 'module' })
  const candidates = []
  walk(ast, (node) => {
    if (node.type !== 'ClassExpression' && node.type !== 'ClassDeclaration') return
    const methods = node.body.body.filter((item) => item.type === 'ClassMethod')
    const names = methods.map((item) => keyOf(item.key))
    if (!['register', 'entriesOfSlot', 'record', 'getVersion'].every((name) => names.includes(name))) return
    const method = methods.find((item) => keyOf(item.key) === 'register')
    if (!source.slice(method.start, method.end).includes('requires options.id')) return
    candidates.push({ node, method })
  })
  if (candidates.length !== 1) throw new Error(`Expected one bundled SlotCore, found ${candidates.length}`)
  return candidates[0]
}
/** Parsed range insertion, never a search/replace over a minifier's symbol names. */
export function patchBundledSlotCore(source, parse) {
  const { method } = locateBundledSlotCore(source, parse)
  const parameter = method.params[0]
  if (parameter?.type !== 'Identifier') throw new Error('Unexpected SlotCore register signature')
  const objects = []
  walk(method.body, (node) => {
    if (node.type !== 'ObjectProperty' || keyOf(node.key) !== 'options' || node.value.type !== 'ObjectExpression') return
    const properties = node.value.properties
    const names = properties.map((item) => {
      if (item.type !== 'SpreadElement' || item.argument.type !== 'ConditionalExpression') return null
      const branch = item.argument.consequent
      if (branch.type !== 'ObjectExpression' || branch.properties.length !== 1) return null
      const property = branch.properties[0]
      const value = property.value
      const name = keyOf(property.key)
      return value?.type === 'MemberExpression' && value.object?.name === parameter.name && keyOf(value.property) === name ? name : null
    })
    if (JSON.stringify(names) === JSON.stringify(['key', 'id', 'order', 'label', 'priority'])) objects.push(node.value)
  })
  if (objects.length !== 1) throw new Error('Expected one pristine stored-options object in bundled SlotCore')
  const object = objects[0]
  // Inserting before the first existing property also accepts formatted input.
  const at = object.properties[0].start
  const insertion = `...typeof ${parameter.name}.icon === "function" ? {icon:${parameter.name}.icon} : {},`
  const patched = source.slice(0, at) + insertion + source.slice(at)
  parse(patched, { sourceType: 'module' })
  return patched
}
function imports(source, parse) {
  const values = []
  walk(parse(source, { sourceType: 'module' }), (node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (node.source) values.push(node.source.value)
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Import' && node.arguments[0]?.type === 'StringLiteral') values.push(node.arguments[0].value)
    if (node.type === 'ImportExpression' && node.source?.type === 'StringLiteral') values.push(node.source.value)
  })
  return values.sort()
}
export function loadToolchain(root) {
  const require = createRequire(join(root, 'package.json'))
  try { return { parse: require('@babel/parser').parse, transform: require('esbuild').transform } }
  catch (error) { throw new Error('Build requires @babel/parser and esbuild resolvable from --root; no files changed', { cause: error }) }
}
function checkVersions(root) {
  for (const [name, version] of Object.entries(VERSIONS)) {
    const actual = JSON.parse(readFileSync(join(root, PREFIX, name, 'package.json'), 'utf8')).version
    if (actual !== version) throw new Error(`${name}: expected ${version}, found ${actual}; review upstream changes before patching`)
  }
}
function pristineSources(root) {
  checkVersions(root)
  const sources = {}
  for (const [key, path] of Object.entries(PATHS)) {
    const source = readFileSync(join(root, path), 'utf8')
    if (sha256(source) !== HASHES[key]) throw new Error(`${path}: pristine SHA-256 mismatch; refusing to overwrite an unknown build`)
    sources[key] = source
  }
  return sources
}
export async function planPatch(root) {
  const sources = pristineSources(root)
  const { parse, transform } = loadToolchain(root)
  const source = patchBundledSlotCore(sources.entry, parse)
  const rebuilt = await transform(source, {
    loader: 'js', format: 'esm', target: 'esnext', minify: true,
    legalComments: 'inline', banner: `/* ${PATCH_ID}: parsed SlotCore icon metadata extension */`,
  })
  parse(rebuilt.code, { sourceType: 'module' })
  if (JSON.stringify(imports(sources.entry, parse)) !== JSON.stringify(imports(rebuilt.code, parse))) throw new Error('Rebuilt shell import graph changed')
  const entryName = `index-settings-icons-${sha256(rebuilt.code).slice(0, 16)}.js`
  const entryPath = dirname(PATHS.entry) + '/' + entryName
  const changes = [
    { path: PATHS.slots, before: sources.slots, after: patchSlotRuntime(sources.slots) },
    { path: PATHS.slotTypes, before: sources.slotTypes, after: patchSlotTypes(sources.slotTypes) },
    { path: PATHS.rowTypes, before: sources.rowTypes, after: replaceOnce(replaceOnce(sources.rowTypes,
      'HostObservable, InjectFace,', 'HostObservable, SlotIcon, InjectFace,', 'row import'),
      '    label: string;\n}', '    label: string;\n    icon?: SlotIcon;\n}', 'row icon') },
    { path: PATHS.contract, before: sources.contract, after: replaceOnce(sources.contract,
      '         * position), `label` (registrant-localized display text',
      '         * position), optional `icon` (a pure SlotIcon renderer; receives size/className),\n         * and `label` (registrant-localized display text', 'settings slot documentation') },
    { path: PATHS.settings, before: sources.settings, after: patchSettingsClient(sources.settings) },
    { path: entryPath, before: null, after: rebuilt.code },
    { path: PATHS.html, before: sources.html, after: replaceOnce(sources.html, './assets/index-Df-65__b.js', './assets/' + entryName, 'Web entry URL') },
  ]
  for (const change of changes) {
    if (change.path.endsWith('.js')) parse(change.after, { sourceType: 'module' })
    if (change.before === null && existsSync(join(root, change.path))) throw new Error(`New artifact path already exists: ${change.path}`)
  }
  return { changes, entryPath }
}
function atomicWrite(path, content, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + `.${process.pid}.${Date.now()}.tmp`
  try { writeFileSync(temp, content, { flag: 'wx', mode }); renameSync(temp, path) }
  finally { rmSync(temp, { force: true }) }
}
function backupFile(path, source) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    if (sha256(readFileSync(path)) !== sha256(source)) throw new Error(`Backup conflict: ${path}`)
  } else writeFileSync(path, source, { flag: 'wx', mode: 0o600 })
}
function readRecord(root, backup) {
  const path = join(backup, 'manifest.json')
  if (!existsSync(path)) return null
  const record = JSON.parse(readFileSync(path, 'utf8'))
  if (record.patch !== PATCH_ID || record.root !== root || !Array.isArray(record.files)) throw new Error('Backup manifest does not match this installation')
  for (const file of record.files) {
    if (!Object.values(PATHS).includes(file.path) && !/^node_modules\/@deepseek-ai\/dsh-web-frontend\/dist\/assets\/index-settings-icons-[a-f0-9]{16}\.js$/.test(file.path)) throw new Error('Unexpected file in backup manifest')
  }
  return record
}
function verifyInstalled(root, record) {
  checkVersions(root)
  for (const file of record.files) {
    const path = join(root, file.path)
    if (!existsSync(path) || sha256(readFileSync(path)) !== file.after) throw new Error(`Patched file changed or missing: ${file.path}; refusing overwrite/restore`)
  }
  if (sha256(readFileSync(join(root, PATHS.entry))) !== HASHES.entry) throw new Error('Original Web entry changed')
}
export async function run({ root, action = 'check', backupDir }) {
  root = resolve(root)
  if (!['check', 'apply', 'restore'].includes(action)) throw new Error(`Unknown action: ${action}`)
  const backup = resolve(backupDir ?? join(homedir(), '.cache', 'dsh-settings-icons', sha256(root).slice(0, 16), 'v1'))
  const record = readRecord(root, backup)
  if (record) {
    verifyInstalled(root, record)
    if (action !== 'restore') return { status: 'already-applied', entryPath: record.entryPath, backup }
    // Validate every original before restoring any file. Keep immutable backups.
    const originals = record.files.map((file) => {
      const source = file.before === null ? null : readFileSync(join(backup, 'originals', file.path), 'utf8')
      if (source !== null && sha256(source) !== file.before) throw new Error(`Original backup integrity failure: ${file.path}`)
      return { ...file, source }
    })
    // Switch the HTML back first. Remove only the generated file whose hash was verified.
    for (const file of originals.reverse()) {
      const path = join(root, file.path)
      if (file.source === null) rmSync(path)
      else atomicWrite(path, file.source, file.mode)
    }
    renameSync(join(backup, 'manifest.json'), join(backup, `restored-${Date.now()}.json`))
    return { status: 'restored', backup }
  }
  if (action === 'restore') throw new Error('No applied patch manifest found; nothing was changed')
  const plan = await planPatch(root)
  if (action === 'check') return { status: 'ready', files: plan.changes.map((item) => item.path), entryPath: plan.entryPath, backup }
  // Complete the pristine backup set, including the untouched original bundle.
  for (const path of Object.values(PATHS)) backupFile(join(backup, 'originals', path), readFileSync(join(root, path), 'utf8'))
  const files = plan.changes.map((change) => ({
    path: change.path,
    before: change.before === null ? null : sha256(change.before),
    after: sha256(change.after),
    mode: change.before === null ? 0o644 : statSync(join(root, change.path)).mode & 0o777,
  }))
  // Recheck inputs immediately before publishing, after toolchain/build work.
  pristineSources(root)
  const written = []
  try {
    for (const [index, change] of plan.changes.entries()) {
      if (change.before === null && existsSync(join(root, change.path))) throw new Error(`Concurrent artifact creation: ${change.path}`)
      atomicWrite(join(root, change.path), change.after, files[index].mode)
      written.push({ ...change, mode: files[index].mode })
    }
    atomicWrite(join(backup, 'manifest.json'), JSON.stringify({ patch: PATCH_ID, root, entryPath: plan.entryPath, files }, null, 2) + '\n', 0o600)
  } catch (error) {
    for (const change of written.reverse()) {
      if (change.before === null) rmSync(join(root, change.path), { force: true })
      else atomicWrite(join(root, change.path), change.before, change.mode)
    }
    throw error
  }
  return { status: 'applied', files: files.map((item) => item.path), entryPath: plan.entryPath, backup, next: 'Refresh the existing DSH URL; verify its client-hmr poller has loaded the new settings client bundle.' }
}
function argumentsOf(args) {
  const options = { action: 'check' }
  let actionSeen = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--root' || arg === '--backup-dir') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      options[arg === '--root' ? 'root' : 'backupDir'] = value
    } else if (['--check', '--apply', '--restore'].includes(arg)) {
      if (actionSeen) throw new Error('Choose only one action')
      options.action = arg.slice(2); actionSeen = true
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.root) throw new Error('Specify --root /path/to/dsh (the directory containing node_modules)')
  return options
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await run(argumentsOf(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
