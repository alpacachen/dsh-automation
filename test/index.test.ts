import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'
import { inject } from '../src/index.js'

test('plugin rejects an invalid maximum run duration before startup', async () => {
  await assert.rejects(() => apply({} as Context, { maxRunDurationMs: 0 }), /maxRunDurationMs/)
})

test('plugin injects Host model and skill registries', () => {
  assert.ok(inject.includes('llm'))
  assert.ok(inject.includes('skills'))
})
