import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShellExecutor, ShellProcess } from '@deepseek-ai/dsh-shell'
import { DRIVER_DEVICE, DRIVER_REFRESH, parseDriverMessage, runDeviceDriver, VERIFICATION_URL } from '../src/driver.js'
import { FAILURE_CODES, SubscriptionError, oauthFailureCode } from '../src/errors.js'

function harness(chunks: string[], running = false) {
  let killed = false
  const proc = {
    status: running ? 'running' : 'completed',
    done: Promise.resolve(),
    readOutput: () => ({ delta: chunks.shift() ?? '', lossy: false }),
    kill: () => { killed = true; proc.status = 'killed'; return true },
  } as ShellProcess
  const shell = {
    resolve: (spec: unknown) => spec,
    start: () => proc,
  } as unknown as ShellExecutor
  return { proc, shell, killed: () => killed }
}
const result = JSON.stringify({ type: 'result', credential: { access: 'private', refresh: 'private-refresh' } })

test('embedded OAuth drivers execute real Node with a local mock module and stdin', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oasub-driver-'))
  const modulePath = join(directory, "登录 ' mock.mjs")
  try {
    writeFileSync(modulePath, `export const openaiCodexOAuth = {
      async login(interaction) {
        if (await interaction.prompt({ type: 'select' }) !== 'device_code') throw new Error('wrong method')
        interaction.notify({ type: 'device_code', userCode: 'ABCD-1234' })
        return { access: 'mock-access' }
      },
      async refresh(credential) {
        if (credential.refresh !== 'mock-refresh') throw new Error('missing stdin')
        return { access: 'mock-new-access' }
      },
    }`)
    for (const [script, access] of [[DRIVER_DEVICE, 'mock-access'], [DRIVER_REFRESH, 'mock-new-access']] as const) {
      const output = spawnSync(process.execPath, ['--input-type=module', '--eval', script, '--', modulePath], {
        input: JSON.stringify({ refresh: 'mock-refresh' }), encoding: 'utf8', timeout: 5_000,
      })
      assert.equal(output.error, undefined)
      assert.equal(output.status, 0, output.stderr)
      const messages = output.stdout.trim().split('\n').map(parseDriverMessage)
      assert.deepEqual(messages.at(-1), { type: 'result', credential: { access } })
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('driver accepts structured records only and rejects malformed credential messages', async () => {
  for (const value of ['null', '[]', 'false', '1', 'noise']) assert.equal(parseDriverMessage(value), null)
  const { shell } = harness(['null\n[]\n' + JSON.stringify({ type: 'result', credential: { access: ' ' } })])
  await assert.rejects(runDeviceDriver(shell, '/module', new AbortController().signal, () => {}), /invalid-response/)
})

test('driver drains final unterminated results after process completion', async () => {
  const { shell } = harness([result])
  assert.deepEqual(await runDeviceDriver(shell, '/module', new AbortController().signal, () => {}), {
    access: 'private', refresh: 'private-refresh',
  })
})

test('driver handles completion racing the first output read', async () => {
  const { proc, shell } = harness([], true)
  let reads = 0
  proc.readOutput = () => {
    reads++
    if (reads === 1) { proc.status = 'completed'; return { delta: '', lossy: false } }
    return { delta: reads === 2 ? result : '', lossy: false }
  }
  assert.equal((await runDeviceDriver(shell, '/module', new AbortController().signal, () => {}))?.access, 'private')
})

test('driver receives chunked output, only offers official URL, and reaps successful process', async () => {
  const notice = JSON.stringify({ type: 'notice', userCode: 'ABCD-1234', verificationUri: 'https://evil.invalid' }) + '\n'
  const { shell, killed } = harness([notice.slice(0, 20), notice.slice(20) + result + '\n'], true)
  const received: unknown[] = []
  await runDeviceDriver(shell, '/module', new AbortController().signal, (code, url) => received.push([code, url]), { pollMs: 1 })
  assert.deepEqual(received, [['ABCD-1234', VERIFICATION_URL]])
  assert.equal(killed(), true)
})

test('driver abort before start never spawns and mid-flow abort always reaps', async () => {
  const abort = new AbortController()
  abort.abort()
  const shell = { start: () => assert.fail('unexpected spawn') } as unknown as ShellExecutor
  assert.equal(await runDeviceDriver(shell, '/module', abort.signal, () => {}), null)
  const mid = new AbortController()
  const fake = harness([], true)
  fake.proc.readOutput = () => { mid.abort(); return { delta: '', lossy: false } }
  assert.equal(await runDeviceDriver(fake.shell, '/module', mid.signal, () => {}, { pollMs: 1 }), null)
  assert.equal(fake.killed(), true)
})

test('driver bounds startup, total wait, output loss and read failures', async () => {
  for (const timeout of [{ codeTimeoutMs: 1 }, { timeoutMs: 1 }]) {
    const fake = harness([], true)
    await assert.rejects(runDeviceDriver(fake.shell, '/module', new AbortController().signal, () => {}, { ...timeout, pollMs: 2 }), /timeout/)
    assert.equal(fake.killed(), true)
  }
  for (const read of [
    () => ({ delta: '', lossy: true }),
    () => ({ delta: 'x'.repeat(256 * 1024 + 1), lossy: false }),
    () => { throw new SubscriptionError('process-exited') },
  ]) {
    const fake = harness([], true)
    fake.proc.readOutput = read
    await assert.rejects(runDeviceDriver(fake.shell, '/module', new AbortController().signal, () => {}))
    assert.equal(fake.killed(), true)
  }
})

test('driver checks sandbox denial stamped only after process close', async () => {
  const fake = harness([result + '\n'], true)
  let finish!: () => void
  Object.defineProperty(fake.proc, 'done', { value: new Promise<void>((resolve) => { finish = resolve }) })
  fake.proc.kill = () => {
    fake.proc.status = 'killed'
    fake.proc.sandbox = { mode: 'workspace-write', denied: true }
    finish()
    return true
  }
  await assert.rejects(runDeviceDriver(fake.shell, '/module', new AbortController().signal, () => {}), /access-denied/)
})

test('driver emits categorized failures without private diagnostics', async () => {
  for (const [message, code] of [
    ['HTTP 404 device auth not enabled', 'device-auth-disabled'],
    ['403 access denied', 'access-denied'],
    ['invalid_grant', 'authorization-expired'],
    ['429 Too Many Requests', 'rate-limited'],
    ['fetch failed ECONNRESET', 'network'],
    ['TimeoutError', 'timeout'],
    ['ERR_MODULE_NOT_FOUND', 'component-unavailable'],
    ['unrecognized Bearer private', 'unknown'],
  ]) {
    const fake = harness([JSON.stringify({ type: 'error', message: message + ' token=private' }) + '\n'], true)
    await assert.rejects(runDeviceDriver(fake.shell, '/module', new AbortController().signal, () => {}), {
      message: `[openai-subscription:${code}]`,
    })
    assert.equal(fake.killed(), true)
  }
  assert.equal(oauthFailureCode(null), 'unknown')
  for (const code of FAILURE_CODES) assert.equal(new SubscriptionError(code).message, `[openai-subscription:${code}]`)
})
