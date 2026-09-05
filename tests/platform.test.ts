import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { authModuleCandidates, buildNodeCommand, resolveAuthModule, runtimeSupported } from '../src/platform.js'

const AUTH = '@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js'
const DSH = '@deepseek-ai/dsh'
const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai'

function fixture(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "dsh platform 空间 O'Brien "))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function put(path: string, content = ''): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function packageLink(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true })
  // Directory junctions do not require symlink privileges on Windows CI.
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

test('POSIX candidates cover npm, nvm, NODE_PATH and bun with running DSH first', () => {
  const candidates = authModuleCandidates('/opt/dsh/lib/bin.js', '/home/u/.nvm/versions/node/v24/bin/node', {
    NODE_PATH: '/custom modules:/other::/custom modules',
    HOME: '/home/u',
    npm_config_prefix: '/custom npm',
    BUN_INSTALL: '/custom bun',
  }, 'linux')
  const running = posix.join('/opt/dsh/node_modules', AUTH)
  const global = posix.join('/home/u/.nvm/versions/node/v24/lib/node_modules', AUTH)
  assert.ok(candidates.includes(running))
  assert.ok(candidates.indexOf(running) < candidates.indexOf(global))
  for (const root of [
    '/home/u/.nvm/versions/node/v24/lib/node_modules',
    '/custom modules', '/other', '/custom npm/lib/node_modules',
    '/custom bun/install/global/node_modules', '/home/u/.bun/install/global/node_modules',
  ]) assert.ok(candidates.includes(posix.join(root, AUTH)), root)
  assert.ok(candidates.every(posix.isAbsolute))
  assert.equal(new Set(candidates).size, candidates.length)
  assert.ok(candidates.length < 300)
})

test('Windows paths use semicolon NODE_PATH and preserve drives, spaces and Unicode', () => {
  const home = "C:\\Users\\空间 O'Brien"
  const candidates = authModuleCandidates('C:\\DSH 空间\\lib\\bin.js', 'C:\\Program Files\\nodejs\\node.exe', {
    USERPROFILE: home,
    HOME: 'C:\\wrong-home',
    APPDATA: 'D:\\Roaming profile',
    LOCALAPPDATA: 'D:\\Local profile',
    NODE_PATH: 'D:\\Modules;E:\\Another folder;;d:\\modules',
    PNPM_HOME: 'D:\\pnpm',
    NVM_SYMLINK: 'C:\\nvm node',
  }, 'win32')
  for (const root of [
    'C:\\DSH 空间\\node_modules', 'C:\\Program Files\\nodejs\\node_modules',
    'D:\\Modules', 'E:\\Another folder', 'D:\\Roaming profile\\npm\\node_modules',
    'D:\\Local profile\\pnpm\\global\\5\\node_modules', 'D:\\pnpm\\global\\5\\node_modules',
    'C:\\nvm node\\node_modules', win32.join(home, '.bun/install/global/node_modules'),
    win32.join(home, 'AppData/Roaming/npm/node_modules'),
  ]) assert.ok(candidates.includes(win32.join(root, AUTH)), root)
  assert.ok(candidates.every(win32.isAbsolute))
  assert.equal(new Set(candidates.map((path) => path.toLowerCase())).size, candidates.length)
  assert.equal(candidates.some((path) => path.includes('wrong-home')), false)
})

test('pnpm defaults cover macOS, Linux XDG, and Windows profile fallback', () => {
  const cases: Array<[NodeJS.Platform, NodeJS.ProcessEnv, string]> = [
    ['darwin', { HOME: '/Users/u' }, '/Users/u/Library/pnpm/global/5/node_modules'],
    ['linux', { HOME: '/home/u' }, '/home/u/.local/share/pnpm/global/5/node_modules'],
    ['linux', { XDG_DATA_HOME: '/custom data' }, '/custom data/pnpm/global/5/node_modules'],
    ['win32', { HOMEDRIVE: 'D:', HOMEPATH: '\\Users\\u' }, 'D:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules'],
  ]
  for (const [platform, env, root] of cases) {
    const path = platform === 'win32' ? win32 : posix
    assert.ok(authModuleCandidates(undefined, undefined, env, platform).includes(path.join(root, AUTH)))
  }
})

test('runtime floor accepts Node 22.19 and later but not older or malformed versions', () => {
  for (const version of ['22.19.0', '22.20.1', '24.0.0', '26.8.1']) assert.equal(runtimeSupported(version), true, version)
  for (const version of ['22.18.9', '20.19.0', '18.0.0', '', 'unknown', '24']) assert.equal(runtimeSupported(version), false, version)
})

test('lookup prefers running DSH over global and never imports discovered code', (t) => {
  const root = fixture(t)
  const entry = put(join(root, 'running/lib/bin.js'))
  const running = put(join(root, 'running/node_modules', AUTH), 'throw new Error("must not execute")')
  const globalRoot = join(root, 'other/node_modules')
  put(join(globalRoot, AUTH))
  assert.equal(resolveAuthModule(entry, '', { NODE_PATH: globalRoot }), realpathSync(running))
})

test('lookup follows a symlinked DSH entrypoint before unrelated shim-root dependencies', (t) => {
  const root = fixture(t)
  const installed = join(root, 'installed')
  put(join(installed, 'lib/bin.js'))
  const expected = put(join(installed, 'node_modules', AUTH))
  const link = join(root, 'shims/dsh')
  packageLink(installed, link)
  put(join(root, 'shims/node_modules', AUTH))
  const entry = join(link, 'lib/bin.js')
  const candidates = authModuleCandidates(entry, '', {})
  assert.ok(candidates.includes(realpathSync(expected)))
  assert.ok(candidates.indexOf(realpathSync(expected)) < candidates.indexOf(join(root, 'shims/node_modules', AUTH)))
  assert.equal(resolveAuthModule(entry, '', {}), realpathSync(expected))
})

test('pnpm adapter symlink resolves its own import-only pi-ai ahead of a hoisted version', (t) => {
  const root = fixture(t)
  const dsh = join(root, 'dsh')
  const entry = put(join(dsh, 'lib/bin.js'))
  put(join(dsh, 'node_modules', AUTH), '// wrong version')
  const store = join(root, '.pnpm/adapter@1/node_modules')
  const adapter = join(store, ADAPTER)
  put(join(adapter, 'package.json'), JSON.stringify({ name: ADAPTER, exports: { '.': { import: './lib/index.js' } } }))
  const expected = put(join(store, AUTH), 'throw new Error("must not execute")')
  put(join(store, '@earendil-works/pi-ai/package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai', type: 'module', exports: { '.': { import: './dist/index.js' } },
  }))
  packageLink(adapter, join(dsh, 'node_modules', ADAPTER))
  assert.equal(resolveAuthModule(entry, '', {}), realpathSync(expected))
})

test('global DSH dependency beats a standalone pi-ai and resolves pnpm linked DSH', (t) => {
  const root = fixture(t)
  const globalRoot = join(root, 'global/5/node_modules')
  const storedDsh = join(root, 'store/dsh')
  put(join(storedDsh, 'package.json'), '{}')
  const expected = put(join(storedDsh, 'node_modules', AUTH))
  packageLink(storedDsh, join(globalRoot, DSH))
  put(join(globalRoot, AUTH), '// wrong standalone version')
  assert.equal(resolveAuthModule('', '', { NODE_PATH: globalRoot }), realpathSync(expected))
})

test('PATH fallback probes npm cmd shim package roots without executing the shim', (t) => {
  const root = fixture(t)
  const bin = join(root, 'custom bin')
  put(join(bin, process.platform === 'win32' ? 'pi.cmd' : 'pi'), 'this must never be executed')
  const expected = put(join(bin, 'node_modules/@earendil-works/pi-coding-agent/node_modules', AUTH))
  assert.equal(resolveAuthModule('', '', { PATH: bin }), realpathSync(expected))
})

test('PATH fallback follows Unix executable symlinks without readlink', { skip: process.platform === 'win32' }, (t) => {
  const root = fixture(t)
  const entry = put(join(root, 'installed/lib/cli.js'))
  const expected = put(join(root, 'installed/node_modules', AUTH))
  const bin = join(root, 'custom bin')
  mkdirSync(bin)
  symlinkSync(entry, join(bin, 'pi'))
  assert.equal(resolveAuthModule('', '', { PATH: bin }), realpathSync(expected))
})

test('lookup skips directories and missing modules, and can find a later installed file', (t) => {
  const root = fixture(t)
  const a = join(root, 'a')
  const b = join(root, 'b')
  mkdirSync(join(a, AUTH), { recursive: true })
  const env = { NODE_PATH: [a, b].join(process.platform === 'win32' ? ';' : ':') }
  assert.equal(resolveAuthModule('', '', env), '')
  const expected = put(join(b, AUTH))
  assert.equal(resolveAuthModule('', '', env), realpathSync(expected))
})

test('POSIX commands quote runtime, driver and module separately, including option-like paths', () => {
  const script = "console.log('空间'); // $(nope) `nope` \"quoted\"\n"
  const module = "-module 空间 O'Brien.js"
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
  assert.equal(buildNodeCommand(script, module, 'linux', "/node O'Brien/路径"),
    quote("/node O'Brien/路径") + ' --input-type=module --eval ' + quote(script) + ' -- ' + quote(module))
  assert.ok(buildNodeCommand('', '', 'linux').startsWith(quote(process.execPath) + ' '))
})

test('PowerShell commands double apostrophes and encode ESM source for native marshalling', () => {
  const script = 'import { basename } from "node:path"; console.log("$HOME `quote`", basename(process.argv[1]))'
  const command = buildNodeCommand(script, "C:\\Users\\O'Brien 空间\\auth.js", 'win32', "C:\\Node O'Brien 空间\\node.exe")
  assert.ok(command.startsWith("& 'C:\\Node O''Brien 空间\\node.exe' --input-type=module --eval '"))
  assert.ok(command.endsWith(" -- 'C:\\Users\\O''Brien 空间\\auth.js'"))
  const encoded = /data:text\/javascript;base64,([A-Za-z0-9+/=]+)/.exec(command)?.[1]
  assert.ok(encoded)
  assert.equal(Buffer.from(encoded, 'base64').toString(), script)
  assert.equal(command.includes('$HOME'), false)
  assert.equal(command.includes('`quote`'), false)
})

test('commands reject NUL in every argument rather than silently truncating', () => {
  for (const platform of ['linux', 'win32'] as const) {
    assert.throws(() => buildNodeCommand('a\0b', '', platform), /NUL/)
    assert.throws(() => buildNodeCommand('', 'a\0b', platform), /NUL/)
    assert.throws(() => buildNodeCommand('', '', platform, 'a\0b'), /NUL/)
  }
})

test('native shell execution preserves Unicode, apostrophes and JavaScript metacharacters', () => {
  const script = [
    'import { pathToFileURL } from "node:url"',
    'process.stdout.write(JSON.stringify({ arg: process.argv[1], literal: "空间 $HOME `literal` \\\"quote\\\" O\'Brien", protocol: pathToFileURL(process.argv[1]).protocol }))',
  ].join('\n')
  const module = process.platform === 'win32' ? "C:\\Users\\空间 O'Brien\\auth.js" : "/tmp/空间 O'Brien/$(printf INJECTED); auth.js"
  const command = buildNodeCommand(script, module)
  for (const shell of process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['bash']) {
    // Match DSH pwsh-local's UTF-8 preamble, including its legacy 5.1 fallback.
    const preamble = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
    const args = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', preamble + command]
      : ['-c', command]
    const result = spawnSync(shell, args, { encoding: 'utf8', timeout: 10_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      arg: module, literal: '空间 $HOME `literal` "quote" O\'Brien', protocol: 'file:',
    })
  }
})

// The script runner is tested as a CLI to avoid exposing test-only production APIs.
const runnerPath = fileURLToPath(new URL('../../scripts/run-scripts.mjs', import.meta.url))

test('script runner invokes JavaScript package managers with current Node and preserves order', (t) => {
  const root = fixture(t)
  const log = join(root, 'log.jsonl')
  const cli = put(join(root, 'manager 空间.mjs'), [
    'import { appendFileSync } from "node:fs"',
    'appendFileSync(process.env.TEST_SCRIPT_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")',
  ].join('\n'))
  const result = spawnSync(process.execPath, [runnerPath, 'typecheck', 'test:platform'], {
    env: { ...process.env, npm_execpath: cli, TEST_SCRIPT_LOG: log }, encoding: 'utf8', timeout: 10_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), [
    ['run', 'typecheck'], ['run', 'test:platform'],
  ])
})

test('script runner preserves failure status and stops the batch', (t) => {
  const root = fixture(t)
  const log = join(root, 'log.jsonl')
  const cli = put(join(root, 'manager.mjs'), [
    'import { appendFileSync } from "node:fs"',
    'appendFileSync(process.env.TEST_SCRIPT_LOG, process.argv[3] + "\\n")',
    'if (process.argv[3] === "build") process.exit(7)',
  ].join('\n'))
  const result = spawnSync(process.execPath, [runnerPath, 'typecheck', 'build', 'test'], {
    env: { ...process.env, npm_execpath: cli, TEST_SCRIPT_LOG: log }, encoding: 'utf8', timeout: 10_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 7, result.stderr)
  assert.equal(readFileSync(log, 'utf8'), 'typecheck\nbuild\n')
})

test('script runner rejects shell metacharacters before running any script', () => {
  const result = spawnSync(process.execPath, [runnerPath, 'test&echo INJECTED'], {
    env: { ...process.env, npm_execpath: 'not-used.cmd' }, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid script name/)
})

test('Windows script runner executes cmd shims securely in paths containing spaces', { skip: process.platform !== 'win32' }, (t) => {
  const root = fixture(t)
  const marker = join(root, 'marker.txt')
  const shim = put(join(root, 'manager & (safe) ! ^.cmd'), '@echo off\r\necho %1,%2>"%TEST_SCRIPT_LOG%"\r\n')
  const result = spawnSync(process.execPath, [runnerPath, 'test:platform'], {
    env: { ...process.env, npm_execpath: shim, TEST_SCRIPT_LOG: marker }, encoding: 'utf8', timeout: 10_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(marker, 'utf8').trim().replaceAll('"', ''), 'run,test:platform')
})

test('Windows runner rejects percent expansion in cmd executable paths', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(process.execPath, [runnerPath, 'test'], {
    env: { ...process.env, npm_execpath: 'C:\\%MALICIOUS%\\npm.cmd' }, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Unsafe Windows command path/)
})
