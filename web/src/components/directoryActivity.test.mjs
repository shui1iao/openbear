import test from 'node:test';
import assert from 'node:assert/strict';
import {activityLabel, withActivityReadVersion} from '../conversationActivity.js';
import {directoryActivitySummaries} from './directoryActivity.js';

const folders = [{folderId: 'F', parentId: ''}, {folderId: 'sub', parentId: 'F'}, {folderId: 'deep', parentId: 'sub'}];
const targets = [['direct', 'F', ['F']], ['unloaded descendants', 'deep', ['F', 'sub', 'deep']], ['temporary', '', ['__temporary']]];
const item = (folderId, state, result, extra = {}) => withActivityReadVersion({conversationUuid: 'root-task', folderId,
  running: true, activityState: state, activityVersion: 3, activityReadVersion: 2,
  activityResult: {status: result}, activityPending: state === 'waiting' ? [{action: 'confirm'}] : [], ...extra});

for (const [location, folderId, ids] of targets) for (const state of ['running', 'waiting']) for (const result of ['completed', 'error']) {
  test(`${location}: ${state} with intermediate Agent ${result} does not contribute terminal unread`, () => {
    const active = item(folderId, state, result);
    const summaries = directoryActivitySummaries([active], folders);
    assert.deepEqual([...summaries.keys()], [...ids].reverse());
    for (const id of ids) {
      const summary = summaries.get(id);
      assert.equal(summary[state].count, 1);
      assert.equal(summary.unread.count, 0);
      assert.doesNotMatch(summary.text, /未读|已完成|失败/);
    }
    assert.equal(active.activityUnread, true, 'aggregation must not acknowledge or mutate the result');
    assert.equal(active.activityReadVersion, 2);
  });
}

for (const [location, folderId, ids] of targets) test(`${location}: terminal result keeps exact-version unread across all outcome types`, () => {
  for (const result of ['completed', 'failed', 'error', 'cancelled', 'interrupted', 'partial']) {
    const terminal = item(folderId, result, result, {running: false});
    for (const id of ids) {
      const summary = directoryActivitySummaries([terminal], folders).get(id);
      assert.equal(summary.unread.count, 1);
      assert.ok(summary.unread.text.includes(activityLabel(terminal)));
      assert.equal(summary.running.count, 0); assert.equal(summary.waiting.count, 0);
    }
    assert.equal(directoryActivitySummaries([withActivityReadVersion(terminal, 3)], folders).size, 0);
    assert.equal(directoryActivitySummaries([withActivityReadVersion({...terminal, activityVersion: 4}, 3)], folders).get(ids[0]).unread.count, 1);
  }
});

test('waiting metadata with no running flag still suppresses an intermediate Agent result', () => {
  const summary = directoryActivitySummaries([item('deep', 'waiting', 'completed', {running: false})], folders).get('F');
  assert.equal(summary.waiting.count, 1); assert.equal(summary.unread.count, 0);
  assert.doesNotMatch(summary.text, /未读|已完成/);
});
