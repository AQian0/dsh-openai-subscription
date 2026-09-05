import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Node 22/24 do not discover tests from an explicit directory argument, and
// Windows shells do not reliably expand globs. Pass a sorted argv list instead.
const directory = new URL('../.test-dist/tests/', import.meta.url)
const files = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => fileURLToPath(new URL(entry.name, directory)))
  .sort()

if (files.length === 0) {
  console.error('No compiled test files found in .test-dist/tests')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: process.env })
if (result.error) {
  console.error('Failed to start the test runner:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
