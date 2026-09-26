import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { selectedSessionId } from '../src/client/session-selection.js'

const row = (id: string, mainView = 0) => ({
  id: SessionId(id), displayTitle: id, running: false, blank: false, updatedAt: 0,
  retainedBy: { mainView, gateway: 1 },
} satisfies SessionSummary)

test('selection follows mainView ownership, not list order or other consumers', () => {
  const first = row('first')
  const current = row('current', 1)
  const byId = { [first.id]: first, [current.id]: current }
  assert.equal(selectedSessionId({ byId }), current.id)
  current.retainedBy.mainView = 0
  first.retainedBy.mainView = 1
  assert.equal(selectedSessionId({ byId }), first.id)
  first.retainedBy.mainView = 0
  assert.equal(selectedSessionId({ byId }), undefined)
})

test('empty or unselected catalogs do not invent a workspace selection', () => {
  assert.equal(selectedSessionId({ byId: {} }), undefined)
  const unselected = row('unselected')
  assert.equal(selectedSessionId({ byId: { [unselected.id]: unselected } }), undefined)
})
