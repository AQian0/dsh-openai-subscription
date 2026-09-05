import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { setTimeout as delay } from 'node:timers/promises'
import { SubscriptionError, oauthFailureCode } from './errors.js'
import { normalizeOAuthCredential, type OAuthCredential } from './oauth.js'
import { buildNodeCommand } from './platform.js'

export const VERIFICATION_URL = 'https://auth.openai.com/codex/device'
const MAX_OUTPUT = 256 * 1024
const DEVICE_TIMEOUT = 15 * 60 * 1000

// Catch import failures as well as OAuth errors. Tokens only travel over stdin/stdout,
// never in command arguments or environment variables.
export const DRIVER_DEVICE = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdout.on('error', () => {})
try {
  const { pathToFileURL } = await import('node:url')
  const { openaiCodexOAuth } = await import(pathToFileURL(process.argv[1]).href)
  const credential = await openaiCodexOAuth.login({
    signal: AbortSignal.timeout(15 * 60 * 1000),
    notify: (n) => out({ ...n, type: 'notice' }),
    prompt: async (p) => {
      if (p.type === 'select') return 'device_code'
      throw new Error('Unsupported authorization interaction')
    },
  })
  out({ type: 'result', credential })
} catch (error) {
  out({ type: 'error', message: error instanceof Error ? error.message : String(error) })
}
`

export const DRIVER_REFRESH = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdout.on('error', () => {})
try {
  const { readFileSync } = await import('node:fs')
  const { pathToFileURL } = await import('node:url')
  const { openaiCodexOAuth } = await import(pathToFileURL(process.argv[1]).href)
  const credential = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const refreshed = await openaiCodexOAuth.refresh(credential, AbortSignal.timeout(90 * 1000))
  out({ type: 'result', credential: refreshed })
} catch (error) {
  out({ type: 'error', message: error instanceof Error ? error.message : String(error) })
}
`

export function parseDriverMessage(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : null
  } catch { return null }
}

/** Bounded streaming reader; disposal/cancellation always reaps its process. */
export async function runDeviceDriver(
  shell: ShellExecutor,
  modulePath: string,
  signal: AbortSignal,
  notify: (code: string, url: string) => void,
  options: { timeoutMs?: number; codeTimeoutMs?: number; pollMs?: number } = {},
): Promise<OAuthCredential | null> {
  if (signal.aborted) return null
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEVICE_TIMEOUT)
  const combined = AbortSignal.any([signal, timeout])
  const proc = shell.start(shell.resolve({
    command: buildNodeCommand(DRIVER_DEVICE, modulePath),
    signal: combined,
    stdoutMaxBytes: MAX_OUTPUT,
  }))
  let buffer = ''
  let total = 0
  let codeReceived = false
  let credential: OAuthCredential | null = null
  const codeDeadline = Date.now() + (options.codeTimeoutMs ?? 45_000)
  try {
    while (true) {
      if (signal.aborted) return null
      if (timeout.aborted || (!codeReceived && Date.now() >= codeDeadline)) throw new SubscriptionError('timeout')
      const read = proc.readOutput()
      total += Buffer.byteLength(read.delta)
      if (read.lossy || total > MAX_OUTPUT) throw new SubscriptionError('invalid-response')
      buffer += read.delta
      // Read final unterminated JSON too, then drain any bytes that arrive
      // between this read and observing process completion.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (proc.status !== 'running' && buffer.trim()) {
        lines.push(buffer)
        buffer = ''
      }
      for (const line of lines) {
        const message = parseDriverMessage(line)
        if (message === null) continue
        if (message.type === 'error') throw new SubscriptionError(oauthFailureCode(message.message))
        if (message.type === 'result') {
          credential = normalizeOAuthCredential(message.credential)
          if (credential === null) throw new SubscriptionError('invalid-response')
          break
        }
        if (message.type === 'notice' && typeof message.userCode === 'string' && /^[A-Za-z0-9-]{3,32}$/.test(message.userCode)) {
          codeReceived = true
          // Never forward an arbitrary URL supplied by a dependency.
          notify(message.userCode, VERIFICATION_URL)
        }
      }
      if (credential !== null) break
      if (proc.status !== 'running') {
        // A close between readOutput() and status can make final bytes available.
        const tail = proc.readOutput()
        if (tail.delta || tail.lossy) {
          total += Buffer.byteLength(tail.delta)
          if (tail.lossy || total > MAX_OUTPUT) throw new SubscriptionError('invalid-response')
          buffer += tail.delta
          continue
        }
        throw new SubscriptionError(proc.sandbox?.denied ? 'access-denied' : 'process-exited')
      }
      await delay(options.pollMs ?? 250, undefined, { signal: combined }).catch(() => {})
    }
  } finally {
    try { if (proc.status === 'running') proc.kill() } finally { await proc.done }
    // Sandbox facts may only be stamped at process close, after a result line.
    if (!signal.aborted && proc.sandbox?.denied) throw new SubscriptionError('access-denied')
  }
  return signal.aborted ? null : credential
}
