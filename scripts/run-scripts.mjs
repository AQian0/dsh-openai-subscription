import { spawnSync } from 'node:child_process'

const scripts = process.argv.slice(2)

if (scripts.length === 0) {
  console.error('Usage: node scripts/run-scripts.mjs <script> [...scripts]')
  process.exit(1)
}

// Names are passed to a package manager, not evaluated as shell fragments.
// Validate the complete batch before starting anything, including on Unix.
for (const script of scripts) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(script)) {
    console.error(`Invalid script name: ${JSON.stringify(script)}`)
    process.exit(1)
  }
}

const execPath = process.env.npm_execpath
const isJavaScriptRunner = execPath && /\.[cm]?js$/i.test(execPath)
const command = execPath
  ? isJavaScriptRunner
    ? process.execPath
    : execPath
  : process.platform === 'win32'
    ? 'npm.cmd'
    : 'npm'
const commandArgs = isJavaScriptRunner ? [execPath] : []
const isWindowsBatch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)

// Batch files cannot be passed directly to spawn on Windows. Use an explicit
// cmd invocation only for those files, never shell:true for arbitrary argv.
// Quoting protects spaces, Unicode, apostrophes and command metacharacters;
// reject quote/control/percent characters that can escape or expand in cmd.
// /d disables AutoRun, /v:off disables delayed (!) expansion, /s fixes /c quotes.
if (isWindowsBatch && /["%\u0000-\u001f]/.test(command)) {
  console.error('Unsafe Windows command path: quotes, percent signs and control characters are unsupported')
  process.exit(1)
}

for (const script of scripts) {
  const args = [...commandArgs, 'run', script]
  const result = isWindowsBatch
    ? spawnSync(process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', [
      '/d', '/s', '/v:off', '/c', `""${command}" "run" "${script}""`,
    ], { env: process.env, stdio: 'inherit', windowsVerbatimArguments: true })
    : spawnSync(command, args, { env: process.env, stdio: 'inherit' })

  if (result.error) {
    console.error(`Failed to run script "${script}":`, result.error.message)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
