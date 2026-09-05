import { spawnSync } from 'node:child_process'

const scripts = process.argv.slice(2)

if (scripts.length === 0) {
  console.error('Usage: node scripts/run-scripts.mjs <script> [...scripts]')
  process.exit(1)
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

for (const script of scripts) {
  const result = spawnSync(command, [...commandArgs, 'run', script], {
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) {
    console.error(`Failed to run script "${script}":`, result.error.message)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
