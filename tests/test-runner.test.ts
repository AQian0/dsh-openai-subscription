import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

for (const mode of ['pass', 'fail', 'empty'] as const) {
  test(`portable test launcher handles ${mode} suites without shell globs`, () => {
    const directory = mkdtempSync(join(tmpdir(), "oasub-tests ' "))
    try {
      mkdirSync(join(directory, 'scripts'))
      mkdirSync(join(directory, '.test-dist/tests'), { recursive: true })
      copyFileSync(resolve('scripts/run-tests.mjs'), join(directory, 'scripts/run-tests.mjs'))
      writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}')
      writeFileSync(join(directory, '.test-dist/tests/ignored.js'), "throw new Error('must not run')")
      mkdirSync(join(directory, '.test-dist/tests/ignored.test.js'))
      if (mode !== 'empty') {
        writeFileSync(join(directory, '.test-dist/tests/example.test.js'),
          `require('node:test')('sample', () => { ${mode === 'fail' ? "throw new Error('expected failure')" : ''} })`)
      }
      const env = { ...process.env }
      // This child is a separate test runner, not a nested node:test worker.
      delete env.NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, [join(directory, 'scripts/run-tests.mjs')], {
        encoding: 'utf8', timeout: 10_000, env,
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status, mode === 'pass' ? 0 : 1, result.stderr + result.stdout)
      if (mode === 'empty') assert.match(result.stderr, /No compiled test files/)
      else assert.match(result.stdout, /sample/)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
}
