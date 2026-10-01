// Whether the room offers "remove" on a board card (spa/src/room/boardRemoval.js).
//
// The server decides (rest-api kelabos.removeContribution: host or author);
// this only decides whether to show the button. The cases below are the ones
// where showing it wrongly is visible: a button that always 403s, or a guest's
// own note with no way to take it back.
import assert from 'node:assert/strict'
import { canRemoveContribution, contributionOwner, withoutContribution } from '../src/room/boardRemoval.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok - ${name}`)
  } catch (e) {
    console.error(`FAIL - ${name}`)
    console.error(e)
    process.exitCode = 1
  }
}

const server = { id: 's1', tag: 'LLM_CON', author: 'assistant', at: 1 }
const local = { id: 'l1', tag: 'LLM_CON', author: 'assistant', authorIdentity: 'dev@x.com', origin: 'local', at: 2 }
const note = { id: 'n1', tag: 'note', author: 'guest:abc', authorIdentity: 'guest:abc', at: 3 }
const legacyNote = { id: 'n2', tag: 'note', author: 'bob@x.com', at: 4 }

test('the host may remove anything stored', () => {
  for (const con of [server, local, note, legacyNote]) {
    assert.equal(canRemoveContribution(con, { isHost: true, me: 'host@x.com' }), true, con.id)
  }
})

test('an author may remove their own, and nobody else\'s', () => {
  assert.equal(canRemoveContribution(local, { me: 'dev@x.com' }), true)
  assert.equal(canRemoveContribution(note, { me: 'guest:abc' }), true, 'a guest owns their note')
  assert.equal(canRemoveContribution(legacyNote, { me: 'bob@x.com' }), true, 'pre-field note falls back to author')
  assert.equal(canRemoveContribution(local, { me: 'guest:abc' }), false)
  assert.equal(canRemoveContribution(note, { me: 'dev@x.com' }), false)
})

test('a server-agent post belongs to nobody but the host', () => {
  assert.equal(contributionOwner(server), '', '"assistant" is not an identity')
  assert.equal(canRemoveContribution(server, { me: 'assistant' }), false)
  assert.equal(canRemoveContribution(server, { me: '' }), false)
})

test('nothing ephemeral, unsent or ended is offered', () => {
  const who = { isHost: true, me: 'host@x.com' }
  assert.equal(canRemoveContribution({ ...local, status: 'working' }, who), false)
  assert.equal(canRemoveContribution({ ...local, status: 'skipped' }, who), false)
  assert.equal(canRemoveContribution({ ...note, id: 'local-123' }, who), false)
  assert.equal(canRemoveContribution(local, { ...who, ended: true }), false)
  assert.equal(canRemoveContribution({ ...local, id: '' }, who), false)
})

test('withoutContribution drops by id and leaves the list alone otherwise', () => {
  const list = [server, local, note]
  assert.deepEqual(withoutContribution(list, 'l1').map(c => c.id), ['s1', 'n1'])
  assert.equal(withoutContribution(list, 'nope'), list, 'same array, so React sees no change')
  assert.equal(withoutContribution(list, ''), list)
})

console.log(`\nspa/boardRemoval: ${passed} passed`)
