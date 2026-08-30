import test from 'node:test'
import assert from 'node:assert/strict'
import { en, zh } from '../src/client/locales.js'

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!).sort()
}

test('English and Chinese dictionaries have balanced non-empty entries', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(en) as Array<keyof typeof en>) {
    assert.ok(en[key].trim(), `English ${key} is empty`)
    assert.ok(zh[key].trim(), `Chinese ${key} is empty`)
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} placeholders differ`)
  }
})
