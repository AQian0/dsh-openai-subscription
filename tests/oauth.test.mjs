import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeOAuthCredential } from '../src/oauth.js'

test('rejects malformed credentials and credentials without an access token', () => {
  assert.equal(normalizeOAuthCredential(null), null)
  assert.equal(normalizeOAuthCredential([]), null)
  assert.equal(normalizeOAuthCredential({}), null)
  assert.equal(normalizeOAuthCredential({ access: '' }), null)
  assert.equal(normalizeOAuthCredential({ access: 42 }), null)
})

test('keeps only validated OAuth fields', () => {
  assert.deepEqual(
    normalizeOAuthCredential({
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 1_900_000_000_000,
      accountId: 'account-id',
      ignored: 'value',
    }),
    {
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 1_900_000_000_000,
      accountId: 'account-id',
    },
  )
})

test('inherits stable fields omitted by a refresh response', () => {
  assert.deepEqual(
    normalizeOAuthCredential(
      { access: 'new-access', expires: Number.NaN },
      {
        access: 'old-access',
        refresh: 'rotating-refresh',
        expires: 1_900_000_000_000,
        accountId: 'account-id',
      },
    ),
    {
      access: 'new-access',
      refresh: 'rotating-refresh',
      expires: 1_900_000_000_000,
      accountId: 'account-id',
    },
  )
})

test('prefers valid fields returned by refresh over fallback values', () => {
  assert.deepEqual(
    normalizeOAuthCredential(
      {
        access: 'new-access',
        refresh: 'new-refresh',
        expires: 2_000_000_000_000,
        accountId: 'new-account',
      },
      {
        refresh: 'old-refresh',
        expires: 1_900_000_000_000,
        accountId: 'old-account',
      },
    ),
    {
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 2_000_000_000_000,
      accountId: 'new-account',
    },
  )
})
