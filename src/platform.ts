import { realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, posix, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

const AUTH_PACKAGE = '@earendil-works/pi-ai'
const AUTH_RELATIVE = 'dist/auth/oauth/openai-codex.js'
const ADAPTER_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const PI_CLI_PACKAGE = '@earendil-works/pi-coding-agent'

function paths(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix
}

/** Canonical targets precede shims/symlinks, without invoking readlink or a shell. */
function entryPaths(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return []
  const normalized = paths(platform).resolve(value)
  if (platform === process.platform) {
    try {
      const actual = realpathSync(normalized)
      if (actual !== normalized) return [actual, normalized]
    } catch {
      // Missing/inaccessible paths still provide useful lexical fallback roots.
    }
  }
  return [normalized]
}

function moduleRoots(entry: string, platform: NodeJS.Platform): string[] {
  const path = paths(platform)
  const roots: string[] = []
  let directory = path.dirname(entry)
  for (let depth = 0; depth < 40; depth++) {
    if (path.basename(directory) !== 'node_modules') roots.push(path.join(directory, 'node_modules'))
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return roots
}

function globalRoots(nodeBinary: string | undefined, env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform): string[] {
  const path = paths(platform)
  const roots: string[] = []
  const addPrefix = (prefix: string | undefined): void => {
    if (!prefix) return
    roots.push(path.join(prefix, 'node_modules'), path.join(prefix, 'lib/node_modules'))
  }
  const addPnpm = (home: string | undefined): void => {
    if (!home) return
    roots.push(path.join(home, 'global/5/node_modules'), path.join(home, 'global/node_modules'))
  }
  for (const binary of entryPaths(nodeBinary, platform)) {
    const directory = path.dirname(binary)
    roots.push(path.resolve(directory, '../lib/node_modules'), path.join(directory, 'node_modules'))
  }
  for (const root of env?.NODE_PATH?.split(path.delimiter) ?? []) {
    if (root) roots.push(root, path.join(root, 'node_modules'))
  }
  addPrefix(env?.npm_config_prefix ?? env?.NPM_CONFIG_PREFIX ?? env?.PREFIX)
  if (env?.NVM_BIN) roots.push(path.resolve(env.NVM_BIN, '../lib/node_modules'))
  addPrefix(env?.NVM_SYMLINK)
  addPnpm(env?.PNPM_HOME)
  if (env?.BUN_INSTALL) roots.push(path.join(env.BUN_INSTALL, 'install/global/node_modules'))

  if (platform === 'win32') {
    if (env?.APPDATA) roots.push(path.join(env.APPDATA, 'npm/node_modules'))
    if (env?.LOCALAPPDATA) addPnpm(path.join(env.LOCALAPPDATA, 'pnpm'))
  }
  if (env?.XDG_DATA_HOME) addPnpm(path.join(env.XDG_DATA_HOME, 'pnpm'))
  const home = platform === 'win32'
    ? env?.USERPROFILE || (env?.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : env?.HOME)
    : env?.HOME
  if (home) {
    roots.push(path.join(home, '.bun/install/global/node_modules'))
    addPrefix(path.join(home, '.npm-global'))
    addPrefix(path.join(home, '.local'))
    if (platform === 'win32') {
      roots.push(path.join(home, 'AppData/Roaming/npm/node_modules'))
      addPnpm(path.join(home, 'AppData/Local/pnpm'))
    } else if (platform === 'darwin') {
      addPnpm(path.join(home, 'Library/pnpm'))
    } else {
      addPnpm(path.join(home, '.local/share/pnpm'))
    }
  }
  return roots
}

function pathDirectories(env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform): string[] {
  return ((platform === 'win32' ? env?.PATH ?? env?.Path : env?.PATH) ?? '')
    .split(paths(platform).delimiter).filter(Boolean)
}

function pathEntries(env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform): string[] {
  if (platform !== process.platform) return []
  const entries: string[] = []
  for (const name of ['dsh', 'pi', 'pi-ai']) {
    for (const directory of pathDirectories(env, platform)) {
      for (const suffix of platform === 'win32' ? ['.cmd', '.exe', '.js', ''] : ['']) {
        const entry = file(join(directory, name + suffix))
        if (entry) entries.push(entry)
      }
    }
  }
  return entries
}

function pathRoots(env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform): string[] {
  const path = paths(platform)
  return pathDirectories(env, platform).flatMap((directory) => [
    path.join(directory, 'node_modules'), path.resolve(directory, '../lib/node_modules'),
  ])
}

function lookupRoots(entryScript: string | undefined, nodeBinary: string | undefined, env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform): string[] {
  return [
    ...entryPaths(entryScript, platform).flatMap((entry) => moduleRoots(entry, platform)),
    ...globalRoots(nodeBinary, env, platform),
    ...pathEntries(env, platform).flatMap((entry) => moduleRoots(entry, platform)),
    ...pathRoots(env, platform),
  ]
}

/**
 * Ordered filesystem fallbacks: running DSH first, then Node/npm/nvm,
 * NODE_PATH and user pnpm/bun roots. The fourth argument permits portable
 * win32 fixtures; omitted, it uses the current OS and preserves the old API.
 * This list is not a trust decision and does not import any candidate.
 */
export function authModuleCandidates(
  entryScript: string | undefined,
  nodeBinary: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const path = paths(platform)
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const root of lookupRoots(entryScript, nodeBinary, env, platform)) {
    for (const base of [
      path.join(root, DSH_PACKAGE, 'node_modules', ADAPTER_PACKAGE, 'node_modules'),
      path.join(root, DSH_PACKAGE, 'node_modules'),
      path.join(root, ADAPTER_PACKAGE, 'node_modules'),
      root,
      path.join(root, PI_CLI_PACKAGE, 'node_modules'),
    ]) {
      const candidate = path.resolve(base, AUTH_PACKAGE, AUTH_RELATIVE)
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
    }
  }
  return candidates
}

function file(value: string): string {
  try {
    return statSync(value).isFile() ? realpathSync(value) : ''
  } catch {
    return ''
  }
}

function packageEntry(directory: string): string {
  try {
    return statSync(directory).isDirectory() ? join(realpathSync(directory), 'package.json') : ''
  } catch {
    return ''
  }
}

/** Only local ancestry, not createRequire's ambient NODE_PATH/globalPaths. */
function dependencyRoots(entry: string, name: string): string[] {
  const allowed = new Set(moduleRoots(entry, process.platform))
  try {
    return (createRequire(pathToFileURL(entry)).resolve.paths(name) ?? []).filter((root) => allowed.has(root))
  } catch {
    return [...allowed]
  }
}

function probePiAi(entry: string): string {
  // Walk require's roots rather than requiring/importing the module. pi-ai's
  // exports are import-only and deliberately hide package.json and this file.
  for (const root of dependencyRoots(entry, AUTH_PACKAGE)) {
    const candidate = file(join(root, AUTH_PACKAGE, AUTH_RELATIVE))
    if (candidate) return candidate
  }
  return ''
}

function probeInstallation(entry: string): string {
  // Canonicalizing the adapter follows pnpm's symlink into its virtual store,
  // where its own pi-ai dependency can differ from a top-level hoisted copy.
  for (const root of dependencyRoots(entry, ADAPTER_PACKAGE)) {
    const adapter = packageEntry(join(root, ADAPTER_PACKAGE))
    if (adapter) {
      const candidate = probePiAi(adapter)
      if (candidate) return candidate
    }
  }
  return probePiAi(entry)
}

function probeRoot(root: string): string {
  const dsh = packageEntry(join(root, DSH_PACKAGE))
  if (dsh) {
    const candidate = probeInstallation(dsh)
    if (candidate) return candidate
  }
  const adapter = packageEntry(join(root, ADAPTER_PACKAGE))
  const candidate = (adapter && probePiAi(adapter)) || file(join(root, AUTH_PACKAGE, AUTH_RELATIVE))
  if (candidate) return candidate
  const pi = packageEntry(join(root, PI_CLI_PACKAGE))
  return pi ? probePiAi(pi) : ''
}

/** Find a real file, without loading OAuth code or launching external commands. */
export function resolveAuthModule(
  entryScript: string | undefined = process.argv[1],
  nodeBinary: string | undefined = process.execPath,
  env: NodeJS.ProcessEnv | undefined = process.env,
): string {
  for (const entry of entryPaths(entryScript, process.platform)) {
    const candidate = probeInstallation(entry)
    if (candidate) return candidate
  }
  for (const root of globalRoots(nodeBinary, env, process.platform)) {
    const candidate = probeRoot(root)
    if (candidate) return candidate
  }
  // Last-resort replacement for `command -v pi`: inspect PATH entries with
  // Node fs only. Canonical targets cover Unix symlinks; adjacent package
  // roots cover npm's Windows .cmd shims without parsing or executing them.
  for (const entry of pathEntries(env, process.platform)) {
    const candidate = probeInstallation(entry)
    if (candidate) return candidate
  }
  for (const root of pathRoots(env, process.platform)) {
    const candidate = probeRoot(root)
    if (candidate) return candidate
  }
  return ''
}

/** pi-ai's supported Node floor; reject malformed version reports conservatively. */
export function runtimeSupported(version = process.versions.node): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  return major > 22 || (major === 22 && Number(match[2]) >= 19)
}

/**
 * Build only a command; callers MUST keep execution through ctx.shell.
 * Default DSH providers use POSIX Bash on Unix and PowerShell on Windows.
 * Custom providers using a different dialect need an explicit platform override.
 */
export function buildNodeCommand(
  script: string,
  modulePath: string,
  platform: NodeJS.Platform = process.platform,
  nodeBinary = process.execPath,
): string {
  if ([script, modulePath, nodeBinary].some((value) => value.includes('\0'))) {
    throw new TypeError('Node command arguments must not contain NUL')
  }
  if (platform === 'win32') {
    const quote = (value: string): string => "'" + value.replace(/'/g, "''") + "'"
    // No embedded double quotes in the native eval argument: this also works
    // with Windows PowerShell's legacy native argument marshalling. Data URLs
    // retain ESM syntax without temporary files; drivers use node: imports and
    // the absolute modulePath argument, not relative imports from this module.
    const bootstrap = "await import('data:text/javascript;base64," + Buffer.from(script).toString('base64') + "')"
    return '& ' + quote(nodeBinary) + ' --input-type=module --eval ' + quote(bootstrap) + ' -- ' + quote(modulePath)
  }
  const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"
  return quote(nodeBinary) + ' --input-type=module --eval ' + quote(script) + ' -- ' + quote(modulePath)
}
