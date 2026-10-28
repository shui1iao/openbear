import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {compile, computed, createSSRApp, ref} from 'vue';
import {renderToString} from 'vue/server-renderer';
import {parse} from '@vue/compiler-sfc';
import {baseParse} from '@vue/compiler-dom';
import postcss from 'postcss';
import {applyOperationFrame, deriveOperationRunState, reduceOperationFrame} from '../../timelineProjection.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const composer = parse(read('./ConsoleComposer.vue')).descriptor;
const view = read('./ConsoleView.vue');
const between = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
};
const helpers = vm.createContext({});
vm.runInContext(between(read('./display.js'), 'export function fmtLiveElapsedMs(', 'export function fmtElapsedFromStart(').replaceAll('export ', ''), helpers);
const walk = nodes => (nodes || []).flatMap(node => [node, ...walk(node.children)]);
const ast = walk(baseParse(composer.template.content).children);
const hasClass = (node, name) => node.type === 1 && node.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes(name));
const row = ast.find(node => hasClass(node, 'composer-reply-run'));
const clock = ast.find(node => hasClass(node, 'composer-reply-clock'));
const composerBinding = astNode => astNode.props.find(prop => prop.name === 'bind' && prop.arg?.content === 'current-reply-run').exp.content;
const viewAst = walk(baseParse(parse(view).descriptor.template.content).children);
const visibleReplyRun = new Function('currentReplyRun', 'activeConversationUuid', `return (${composerBinding(viewAst.find(node => node.tag === 'ConsoleComposer'))});`);

const root = {opId:'run:root', opType:'run', turnId:'turn-1', runRootTurnId:'turn-1', runId:'run-1', displaySeq:10, lifecycle:'active', status:'running', createdAtMs:1000};
const tool = {opId:'tool:1', opType:'tool', turnId:'turn-1', runRootTurnId:'turn-1', runId:'run-1', displaySeq:20, lifecycle:'active', status:'running', createdAtMs:20000};
const agent = {...tool, opId:'agent:1', opType:'agent', taskUuid:'task-1', displaySeq:30, createdAtMs:30000};
const supervisor = {...tool, opId:'supervision:1', opType:'agent_supervision', displaySeq:40, createdAtMs:40000};
const terminal = op => ({...op, lifecycle:'terminal', status:'completed', updatedAtMs:90000});

test('reply origin survives thinking, tools, Agent supervision, terminal root and continuation', () => {
  const status = {...tool, opId:'status:1', opType:'status', createdAtMs:15000};
  const continuation = {...root, opId:'run:continuation', turnId:'continuation', runId:'run-2', parentTurnId:'turn-1', displaySeq:60, createdAtMs:70000};
  const phases = [[root, status], [root, tool], [root, terminal(tool), agent, supervisor], [terminal(root), agent, supervisor], [terminal(root), terminal(agent), terminal(supervisor), continuation]];
  for (const operations of phases) {
    const state = deriveOperationRunState(operations);
    assert.equal(state.running, true);
    assert.equal(state.replyStartedAtMs, 1000);
  }
  assert.equal(deriveOperationRunState(phases[3]).activeStartedAtMs, 30000, 'existing phase/header semantics remain untouched');
  const finished = phases[2].map(terminal);
  assert.equal(deriveOperationRunState(finished).running, false);
  assert.equal(deriveOperationRunState(finished).replyStartedAtMs, 0);
  assert.equal(deriveOperationRunState(phases[2].map(op => ({...terminal(op), status:'stopped'}))).running, false);
});

test('new roots never reuse an older reply or unrelated Agent clock', () => {
  const next = {...root, opId:'run:next', turnId:'turn-2', runRootTurnId:'turn-2', runId:'run-next', displaySeq:100, createdAtMs:120000};
  assert.equal(deriveOperationRunState([terminal(root), agent, next]).replyStartedAtMs, 120000);
  assert.equal(deriveOperationRunState([terminal(root), {...tool, runRootTurnId:'missing-root'}]).replyStartedAtMs, 0);
  assert.equal(deriveOperationRunState([tool, agent, supervisor]).replyStartedAtMs, 0);
  const childRun = {...root, opId:'run:child', taskUuid:'task-1', createdAtMs:500};
  assert.equal(deriveOperationRunState([root, childRun, agent]).replyStartedAtMs, 1000);
  assert.equal(deriveOperationRunState([{...root, internal:true}, agent]).replyStartedAtMs, 0);
});

test('durable root start handles missing/invalid dates without inventing phase or wall-clock origins', () => {
  for (const createdAtMs of [0, -1, NaN, Infinity, 'invalid']) {
    assert.equal(deriveOperationRunState([{...root, createdAtMs}, agent]).replyStartedAtMs, 0);
  }
  assert.equal(deriveOperationRunState([{...root, createdAtMs:0, payload:{startedAtMs:900}}]).replyStartedAtMs, 900);
  const legacyRun = {...root, turnId:'', runRootTurnId:''};
  assert.equal(deriveOperationRunState([legacyRun]).replyStartedAtMs, 1000, 'exact run identity is a safe fallback');
});

// Exercise the durable WS frame -> reducer -> view state -> DOM clock path,
// not just already-normalized HTTP snapshots.
const rootFrame = (extra = {}) => ({...root, revision:1, action:'start', createdAtMs:0, payload:{status:'running'}, ...extra});
function paintReducedReply(operation) {
  const ctx = viewState();
  ctx.syncRunStateFromOperations([operation]);
  const h = elapsedHarness(), el = {};
  h.directive.mounted(el, binding(ctx.currentReplyRun.value.startedAt));
  const text = el.textContent;
  h.directive.beforeUnmount(el);
  return {ctx, text};
}

test('live root with no reliable timestamp stays unknown through reducer, view and clock', () => {
  for (const createdAtMs of [undefined, 0, -1, NaN, Infinity, 'invalid']) {
    const reduced = reduceOperationFrame(null, rootFrame({createdAtMs}));
    const {ctx, text} = paintReducedReply(reduced);
    assert.equal(ctx.running.value, true);
    assert.equal(ctx.currentReplyRun.value.startedAt, 0);
    assert.equal(text, '—');
  }
  const reduced = reduceOperationFrame(null, rootFrame());
  assert.ok(reduced.createdAtMs > 0, 'legacy reducer still supplies its local createdAtMs fallback');
  assert.equal(deriveOperationRunState([reduced]).activeStartedAtMs, reduced.createdAtMs, 'existing Header semantics stay local-fallback-compatible');
});

test('live root uses server payload start without a synthetic createdAtMs masking it', () => {
  for (const createdAtMs of [undefined, 0, -1, NaN, Infinity, 'invalid']) {
    const frame = rootFrame({createdAtMs, payload:{status:'running', startedAtMs:40000}});
    const reduced = reduceOperationFrame(null, frame);
    const {ctx, text} = paintReducedReply(reduced);
    assert.equal(ctx.currentReplyRun.value.startedAt, 40000);
    assert.equal(text, '01:00');
    assert.equal(deriveOperationRunState([{...frame,lifecycle:'active'}]).replyStartedAtMs, 40000, 'HTTP snapshot and real-time frame agree');
  }
});

test('root time provenance preserves server createdAt priority, prior roots and duplicate-frame behavior', () => {
  const frame = rootFrame({createdAtMs:2000,payload:{status:'running',startedAtMs:1000}});
  const first = reduceOperationFrame(null, frame);
  assert.equal(deriveOperationRunState([first]).replyStartedAtMs, 2000);
  const updated = reduceOperationFrame(first, rootFrame({revision:2,action:'patch',payload:{status:'running',startedAtMs:0}}));
  assert.equal(deriveOperationRunState([updated]).replyStartedAtMs, 2000);
  assert.equal(updated.createdAtMs, 2000);
  assert.equal(updated.displaySeq, first.displaySeq);
  assert.strictEqual(reduceOperationFrame(updated, frame), updated, 'late duplicate cannot alter a root');
  const priorSnapshot = {...root,revision:3,payload:{startedAtMs:500}};
  const patched = reduceOperationFrame(priorSnapshot, rootFrame({revision:4,action:'patch'}));
  assert.equal(deriveOperationRunState([patched]).replyStartedAtMs, 1000, 'unmarked HTTP root retains its trustworthy createdAtMs');
});

test('missing-time updates cannot erase a known payload origin and later server metadata can recover unknown roots', () => {
  const first = reduceOperationFrame(null, rootFrame({payload:{status:'running',startedAtMs:40000}}));
  const updated = reduceOperationFrame(first, rootFrame({revision:2,action:'patch',payload:{status:'running',startedAtMs:0}}));
  assert.equal(paintReducedReply(updated).text, '01:00');
  assert.equal(deriveOperationRunState([JSON.parse(JSON.stringify(updated))]).replyStartedAtMs, 40000);
  const recovered = reduceOperationFrame(updated, rootFrame({revision:3,action:'snapshot',createdAtMs:30000}));
  assert.equal(deriveOperationRunState([recovered]).replyStartedAtMs, 30000, 'reliable createdAtMs outranks prior payload fallback');
  assert.equal(recovered.createdAtMs, first.createdAtMs, 'do not rewrite the legacy local createdAtMs used by Header/sorting');
  const unknown = reduceOperationFrame(null, rootFrame());
  const withPayload = reduceOperationFrame(unknown, rootFrame({revision:2,action:'snapshot',payload:{status:'running',startedAtMs:40000}}));
  assert.equal(paintReducedReply(withPayload).text, '01:00');
  const refreshed = {...rootFrame({payload:{status:'running',startedAtMs:40000}}),lifecycle:'active'};
  assert.equal(deriveOperationRunState([refreshed]).replyStartedAtMs, 40000, 'fresh server snapshot needs no in-memory provenance');
  assert.equal(deriveOperationRunState([{...rootFrame(),lifecycle:'active'}]).replyStartedAtMs, 0);
});

test('actual durable frame store keeps unknown and payload origins isolated across updates and stop', () => {
  const store = {operationsById:new Map(),orderedOpIds:[],revisionByOpId:new Map(),lastFrameSeq:0};
  const frame = rootFrame({frameSeq:1,payload:{status:'running',startedAtMs:40000}});
  assert.equal(applyOperationFrame(store, frame), true);
  assert.equal(paintReducedReply(store.operationsById.get(root.opId)).text, '01:00');
  assert.equal(applyOperationFrame(store, {...frame,revision:2,frameSeq:2,action:'patch',payload:{status:'running'}}), true);
  assert.equal(paintReducedReply(store.operationsById.get(root.opId)).text, '01:00');
  assert.equal(applyOperationFrame(store, {...frame,revision:3,frameSeq:3,action:'stop',payload:{status:'cancelled'}}), true);
  assert.equal(deriveOperationRunState([...store.operationsById.values()]).running, false);
  assert.equal(deriveOperationRunState([...store.operationsById.values()]).replyStartedAtMs, 0);
});

function viewState(conversationUuid = 'A') {
  const ctx = vm.createContext({ref, deriveOperationRunState, Date, Map,
    consumePendingAgentAutoOpen(){}, debugFrames(){}, resetTimelinePagination(){},
    conversationStateRequests:{invalidate(){}}, operationFrameBuffer:{reset(){}}, stateStatsByOpId:new Map(),
    pendingLiveUpdates:[], pendingLoadReplaceOperations:false,
  });
  for (const [key, value] of Object.entries({running:false, foregroundRunning:false, rootTurnRunning:false, modelOutputProgress:null, runWaitingLabel:'', activeRunTurnUuid:'', activeRunId:'', runStartedAt:0, currentReplyRun:null, activeConversationUuid:conversationUuid, operationsById:new Map(), orderedOpIds:[], revisionByOpId:new Map(), lastFrameSeq:0, status:''})) ctx[key] = ref(value);
  vm.runInContext(between(view, 'function syncRunStateFromOperations(', 'async function resyncOperationFrames('), ctx);
  vm.runInContext(between(view, 'function clearActiveRun()', 'function replaceOperationSnapshots('), ctx);
  vm.runInContext(between(view, 'function resetOperationStore(', 'function applyCommittedTurnDeletion('), ctx);
  return ctx;
}

test('source wiring recovers from snapshots/refresh, scopes conversation switches and clears on idle', () => {
  const ctx = viewState();
  ctx.syncRunStateFromOperations([root, agent, supervisor]);
  assert.equal(ctx.currentReplyRun.value.startedAt, 1000);
  const refreshed = viewState();
  refreshed.syncRunStateFromOperations(JSON.parse(JSON.stringify([terminal(root), agent, supervisor])));
  assert.equal(refreshed.currentReplyRun.value.startedAt, 1000, 'no local timer history is required');
  ctx.activeConversationUuid.value = 'B';
  assert.equal(visibleReplyRun(ctx.currentReplyRun.value, 'B'), null, 'even before the switch reset, A cannot leak into B');
  ctx.resetOperationStore('B');
  assert.equal(ctx.currentReplyRun.value, null);
  const b = {...root, opId:'run:b', turnId:'turn-b', runRootTurnId:'turn-b', createdAtMs:80000};
  ctx.syncRunStateFromOperations([b]);
  assert.equal(visibleReplyRun(ctx.currentReplyRun.value, 'B').startedAt, 80000);
  ctx.activeConversationUuid.value = 'A';
  ctx.resetOperationStore('A');
  ctx.syncRunStateFromOperations([terminal(root), agent, supervisor]);
  assert.equal(ctx.currentReplyRun.value.startedAt, 1000, 'switching back restores the original root');
  ctx.syncRunStateFromOperations([terminal(root), terminal(agent), terminal(supervisor)]);
  assert.equal(ctx.running.value, false);
  assert.equal(ctx.currentReplyRun.value.startedAt, 0);
  ctx.running.value = true;
  ctx.clearActiveRun();
  assert.equal(ctx.currentReplyRun.value.startedAt, 0, 'optimistic sends/no-operation states stay unknown, not Date.now');
});

test('state-only background fallback does not present its Agent start as reply elapsed', () => {
  const ctx = viewState();
  ctx.syncRunStateFromOperations([], {backgroundRunning:true, backgroundStartedAtMs:70000});
  assert.equal(ctx.running.value, true);
  assert.equal(ctx.runStartedAt.value, 70000);
  assert.equal(ctx.currentReplyRun.value.startedAt, 0);
});

function elapsedHarness() {
  let now = 100000, nextId = 1, created = 0, cleared = 0;
  const timers = new Map();
  const ctx = vm.createContext({...helpers, Date:{now:()=>now}, window:{
    setInterval(fn, ms){assert.equal(ms,250); const id=nextId++;timers.set(id,fn);created++;return id;},
    clearInterval(id){assert.ok(timers.delete(id));cleared++;},
  }});
  vm.runInContext(read('./elapsedDirective.js').replace(/^import .*;\n/, '').replace('export const vElapsed', 'var vElapsed'), ctx);
  return {directive:ctx.vElapsed, tick(value){now=value;for(const fn of timers.values())fn();}, get timers(){return timers.size;}, get created(){return created;}, get cleared(){return cleared;}};
}
const binding = (startAt, extra = {}) => ({value:{startAt,active:true,format:'reply-clock',fallback:'—',...extra}});

test('clock increments through phases without rerender, switches origins, and releases the shared ticker', () => {
  const h = elapsedHarness(), el = {}, legacy = {};
  h.directive.mounted(el, binding(1000));
  assert.equal(el.textContent, '01:39');
  assert.equal(h.created, 1);
  h.tick(102000); assert.equal(el.textContent, '01:41');
  h.directive.updated(el, binding(1000));
  assert.equal(h.created, 1, 'unchanged origin does not recreate the timer');
  h.directive.mounted(legacy, binding(58000, {format:'clock'}));
  assert.equal(legacy.textContent, '00:44');
  assert.equal(h.created, 1, 'old header and new row share one ticker');
  h.directive.updated(el, binding(100000));
  assert.equal(el.textContent, '00:02', 'next reply/session paints only its new origin');
  h.directive.beforeUnmount(el);
  assert.equal(h.timers, 1, 'legacy element still owns the ticker');
  h.directive.beforeUnmount(legacy);
  assert.equal(h.timers, 0);
  assert.equal(h.cleared, 1);
  assert.equal(el._openbearElapsedState, null);
  h.directive.beforeUnmount(el); assert.equal(h.cleared, 1);
});

test('unknown/invalid origin schedules no clock, future/clock-skew clamps zero, stop clears timer', () => {
  const h = elapsedHarness(), el = {};
  for (const startAt of [undefined, 0, -1, NaN, Infinity, 'invalid']) {
    h.directive.updated(el, binding(startAt));
    assert.equal(el.textContent, '—');
    assert.equal(h.timers, 0);
  }
  h.directive.updated(el, binding(120000)); assert.equal(el.textContent, '00:00');
  h.tick(119000); assert.equal(el.textContent, '00:00');
  h.tick(121000); assert.equal(el.textContent, '00:01');
  h.directive.updated(el, binding(120000, {active:false}));
  assert.equal(el.textContent, '—'); assert.equal(h.timers, 0);
  h.directive.beforeUnmount(el); assert.equal(h.cleared, 1);
});

test('composer-only formatter covers minutes, hours, many hours, bad data and negative elapsed', () => {
  for (const [input, expected] of [[0,'00:00'],[999,'00:00'],[59999,'00:59'],[60000,'01:00'],[3599999,'59:59'],[3600000,'1:00:00'],[3661000,'1:01:01'],[360000000,'100:00:00'],[-1,'00:00'],[NaN,'—'],[Infinity,'—'],['invalid','—']]) assert.equal(helpers.fmtReplyElapsedClockMs(input), expected);
  assert.equal(helpers.fmtElapsedClockMs(3601000), '60:01', 'existing header format is unchanged');
});

async function renderRow(props) {
  const render = compile(row.loc.source), bindings = [];
  const app = createSSRApp({render(){return render.call(this, {props,showCurrentReplyRun:props.running && Boolean(props.currentReplyRun)}, []);}});
  app.directive('elapsed', {getSSRProps(binding){bindings.push(binding.value);return {};}});
  return {html:await renderToString(app), bindings};
}

test('lightweight status uses only current reply, hides when stopped or switching, and preserves unknown', async () => {
  const props = {running:true, conversationUuid:'A', currentReplyRun:{startedAt:1000}, durationText:'42m00s'};
  const active = await renderRow(props);
  assert.match(active.html, /本条回复运行中/); assert.match(active.html, /已用/);
  assert.doesNotMatch(active.html, /42m00s/);
  assert.equal(active.bindings[0].startAt, 1000);
  assert.equal(active.bindings[0].format, 'reply-clock');
  assert.equal(active.bindings[0].fallback, '—');
  assert.doesNotMatch((await renderRow({...props, running:false})).html, /本条回复运行中/);
  assert.doesNotMatch((await renderRow({...props, currentReplyRun:null})).html, /本条回复运行中/);
  assert.match((await renderRow({...props, currentReplyRun:{startedAt:0}})).html, /本条回复起点未知/);
  assert.ok(clock.props.some(prop => prop.name === 'aria-live' && prop.value.content === 'off'), 'do not announce every elapsed tick');
});

test('desktop/mobile structure reserves the clock directly above the editor, outside long confirmations and log scroll', () => {
  const content = ast.find(node => hasClass(node,'composer-content'));
  const elements = content.children.filter(node=>node.type===1);
  const index = elements.indexOf(row);
  assert.ok(index > 0);
  assert.ok(hasClass(elements[index - 1], 'composer-prelude'));
  assert.ok(hasClass(elements[index + 1], 'composer-box'));
  assert.ok(walk(elements[index - 1].children).some(node => hasClass(node,'web-confirm-stack')));
  assert.ok(walk(elements[index - 1].children).some(node => hasClass(node,'steering-queue-card')));
  assert.ok(ast.find(node=>node.tag==='footer').children.includes(content));
  const css = postcss.parse(composer.styles[0].content);
  const rule = selector => css.nodes.find(node=>node.type==='rule' && node.selector===selector);
  const declarations = selector => Object.fromEntries(rule(selector).nodes.filter(node=>node.type==='decl').map(node=>[node.prop,node.value]));
  assert.equal(declarations('.has-running-reply .composer-prelude')['overflow-y'], 'auto');
  assert.match(declarations('.has-running-reply .composer-prelude')['max-height'], /mobile-viewport-height/);
  assert.equal(declarations('.has-running-reply .composer-content > :not(.composer-prelude)')['flex-shrink'], '0');
  assert.equal(declarations('.composer-shell.has-running-reply')['max-height'], '100%');
  assert.equal(declarations('.composer-prelude').display, 'contents', 'idle layout remains unchanged');
  assert.equal(declarations('.composer-reply-run')['font-size'], '11px');
  assert.equal(declarations('.composer-reply-run').color, 'var(--ob-text-muted)');
  assert.equal(rule('.composer-reply-run').parent.type, 'root', 'not restricted to desktop or mobile');
  assert.match(view, /<footer|<ConsoleComposer/);
  const scroller = viewAst.find(node => node.props?.some(prop=>prop.name==='ref' && prop.value?.content==='scroller'));
  assert.ok(scroller);
  assert.ok(!walk(scroller.children).some(node=>node.tag==='ConsoleComposer'), 'message log cannot scroll away the composer');
});
