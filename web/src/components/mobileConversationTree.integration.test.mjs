import * as promptPolicy from './promptPolicy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {computed, nextTick, reactive, ref, watch, effectScope, proxyRefs, compile, createSSRApp, h} from 'vue';
import {renderToString} from 'vue/server-renderer';
import {parse, compileTemplate} from '@vue/compiler-sfc';
import {baseParse} from '@vue/compiler-dom';
import * as icons from '@element-plus/icons-vue';
import postcss from 'postcss';
import {useRecentConversationRows} from './conversationRecentRows.js';
import {treeItemId as rowId, treeItemParent, compareTreeItems, resolveTreeDrop} from './conversationTreeInteractions.js';
import {activityLabel, activityState, activityReadRequests, withActivityReadVersion} from '../conversationActivity.js';
import {directoryActivitySummaries} from './directoryActivity.js';
import {REFERENCE_MIME, referenceToken} from '../references/codec.js';

const source = fs.readFileSync(new URL('./ConversationTree.vue', import.meta.url), 'utf8');
const {descriptor} = parse(source);
const walk = nodes => (nodes || []).flatMap(n => n && typeof n === 'object' ? [n, ...walk(Array.isArray(n.children) ? n.children : [])] : []);
const templateNodes = walk(baseParse(descriptor.template.content).children);
const classNode = name => templateNodes.find(n => n.props?.some(p => p.name === 'class' && p.value?.content === name));
const navigationTemplate = '<section>' + ['sidebar-activity','sidebar-tabs','sidebar-panel'].map(name => classNode(name).loc.source).join('\n') + '</section>';
const classes = (n, name) => String(n.props?.class || '').split(/\s+/).includes(name);
const folder = id => ({kind:'folder', id, folderId:id, name:id, path:`目录 ${id}`, conversationCount:1});
const conversation = (id, extra={}) => ({kind:'conversation',id,conversationUuid:id,folderId:'F',title:id,path:'目录 F',lastInteractionAtMs:1000,activityVersion:1,activityReadVersion:1,activityState:'completed',...extra});
const rows = view => view.nodes.filter(n=>classes(n,'tree-row-wrap'));
const ids = view => rows(view).map(n=>n.props['data-tree-id']);
const selected = view => rows(view).filter(n=>walk([n]).some(child=>classes(child,'is-chat-active'))).map(n=>n.props['data-tree-id']);
const settle = async () => {await nextTick();await nextTick();};
function harness(t, {phone=true, storedView='recent', blockedStorage=false, clock=null}={}) {
  const scope=effectScope(), mounted=[], unmounted=[], intervals=new Map(), events=[], reads=[], requests=[], scrolled=[], stored=new Map([['openbear:conversation-sidebar-view',storedView]]);
  const props=reactive({activeConversationUuid:'c',draftConversation:null});
  const catalog=reactive({connected:true,ready:true,activityReadVersions:new Map()});
  const timeouts=new Map(), documentListeners=new Map();let timeoutSerial=0;
  const doc={visibilityState:'visible',addEventListener:(type,fn)=>documentListeners.set(type,fn),removeEventListener:type=>documentListeners.delete(type),
    querySelector:selector=>selector.startsWith('[data-tree-id=')?{scrollIntoView:()=>scrolled.push(selector)}:null};
  let s;
  const api={
    readConversationActivity:async values=>{reads.push(values);return {};},
    conversationTreeFolders:async()=>{requests.push(['folders']);return {items:[{...folder('F'),parentId:''},{...folder('sub'),parentId:'F'},{...folder('deep'),parentId:'sub'}]};},
    conversationTreeBootstrap:async ({conversationUuid}={})=>{
      requests.push(['bootstrap',conversationUuid]);
      const item=conversation(conversationUuid||props.activeConversationUuid);
      return {rootFolders:[folder('F')],activeCount:1,selected:{item,folderPath:['F'],folderItems:[folder('F')]},running:{items:[],recentItems:[item]}};
    },
    conversationTreeChildren:async options=>{requests.push(['children',options]);return {items:options.parentId==='F'?[conversation('c')]:[],hasMore:false};},
    locateConversationFolderInTree:async id=>{requests.push(['folder',id]);return {folderPath:[id],folderItems:[folder(id)]};},
    locateConversationInTree:async id=>{requests.push(['locate',id]);return {item:conversation(id),folderPath:['F'],folderItems:[folder('F')]};},
  };
  const ctx=vm.createContext({...promptPolicy,...icons,directoryActivitySummaries,computed,nextTick,reactive,ref,watch,useRecentConversationRows,rowId,treeItemParent,compareTreeItems,resolveTreeDrop,activityLabel,activityState,activityReadRequests,withActivityReadVersion,
    props,referenceCatalog:catalog,referenceItem:()=>null,acceptActivityReadReceipt(){},REFERENCE_MIME,referenceToken,
    defineLazyView:()=>({}),defineProps:()=>props,defineEmits:()=>(...args)=>events.push(args),defineExpose(){},
    onMounted:fn=>mounted.push(fn),onBeforeUnmount:fn=>unmounted.push(fn),Api:api,apiError:String,ElMessage:{error:value=>assert.fail(String(value))},
    window:{matchMedia:()=>({matches:phone}),localStorage:{getItem:key=>{if(blockedStorage)throw Error('blocked');return stored.get(key);},setItem:(key,value)=>{if(blockedStorage)throw Error('blocked');stored.set(key,value);}},addEventListener(){},removeEventListener(){},setInterval:fn=>{intervals.set(1,fn);return 1;},clearInterval:id=>intervals.delete(id)},
    document:doc,CSS:{escape:s=>s},Date:clock?class extends Date {static now(){return clock.now;}}:Date,
    setTimeout:(fn,delay)=>{if(!clock)return 1;const id=++timeoutSerial;timeouts.set(id,{fn,at:clock.now+delay});return id;},clearTimeout:id=>timeouts.delete(id),
  });
  scope.run(()=>vm.runInContext(descriptor.scriptSetup.content.replace(/^import[\s\S]*?;\n/gm,'')+`
    globalThis.s={sidebarView,isDirectoryView,sidebarScroll,sidebarScrollKey,switchSidebarView,sidebarTabKeydown,showRecentActivity,revealInFolders,revealDraft,locatingConversation,
      activeConversationRow,recentClock,recentConversationRows,recentUnreadRows,recentUnreadCount,recentWaitingCount,recentRunningCount,recentLabel,displayRows,visibleRows,query,initialized,loading,
      activityItems,recentItems,activityReadBusy,titleGenerating,referenceCatalog,rootFolders,stateFor,expanded,selectedFolderId,selectedTargetLabel,emit,menu,listRef,runMenuAction,
      directoryActivity,activateRow,toggleRow,dragStart,dropIntent,dragOver,drop,clearDrag,rootDropTarget,drag,moveInFlight,rowId,rowLabel,rowLoading,nodePath,indentation,isExpanded,running,isTitleGenerating,liveConversationTitle,
      loadChildren,searchHasMore,searchRows,searchLoading,runSearch,locateAndOpen,openMenu,openRootMenu,openMoreMenu,rowKeydown,moreMenuKeydown,clearDropTarget,closeOverview,enterOverview,leaveOverview,markActivityRead,openActivityConversation};
    initialized.value=true; selectedFolderId.value='chosen'; directoryMetadataMounted.value=true;`,ctx));
  t.after(()=>{unmounted.forEach(fn=>fn());scope.stop();});
  s=ctx.s;s.rootFolders.value=[folder('F')];s.stateFor('F').items=[conversation('c')];s.stateFor('F').loaded=true;s.expanded.value=new Set(['F']);s.recentItems.value=[conversation('c')];
  async function render() {
    let vnode;
    const bindings=proxyRefs({...icons,...s,activeConversationUuid:props.activeConversationUuid,activityLabel});
    const draw=compile(navigationTemplate);
    const app=createSSRApp({render(){vnode=draw.call(this,bindings,[]);return vnode;}});
    for(const [name,icon] of Object.entries(icons))app.component(name,icon);
    app.component('AnimatedConversationTitle',{props:['text'],render(){return h('span',this.text);}});
    app.component('el-icon',{render(){return h('i',this.$slots.default?.());}});
    const html=await renderToString(app);return {html,nodes:walk([vnode])};
  }
  return {s,ctx,api,props,catalog,events,reads,requests,scrolled,stored,intervals,mounted,unmounted,timeouts,document:doc,documentListeners,render,run:code=>vm.runInContext(code,ctx)};
}

async function renderCreationMenu(x) {
  const items=[], folders=[];
  const bindings=proxyRefs({...x.s,promptFolder:id=>folders.push(id)});
  const draw=compile(templateNodes.find(n=>n.tag==='el-dropdown-menu').loc.source);
  const app=createSSRApp({render(){return draw.call(this,bindings,[]);}});
  app.component('el-dropdown-menu',{render(){return h('ul',this.$slots.default?.());}});
  app.component('el-dropdown-item',{props:{divided:Boolean},render(){
    const children=this.$slots.default?.()||[];
    const node=h('li',this.$attrs,children);
    items.push({node,divided:this.divided,label:walk(children).filter(n=>typeof n.children==='string').map(n=>n.children).join('').trim()});
    return node;
  }});
  app.component('el-icon',{render(){return h('i',this.$slots.default?.());}});
  for(const name of ['ChatLineRound','FolderAdd'])app.component(name,icons[name]);
  await renderToString(app);return {items,folders};
}

for(const folderId of ['F',''])test(`toolbar creation menu separates temporary chat from ${folderId ? 'selected-folder actions' : 'root-folder creation'} without duplicates`,async t=>{
  const x=harness(t);x.s.selectedFolderId.value=folderId;
  const {items,folders}=await renderCreationMenu(x);
  assert.deepEqual(items.map(i=>i.label),folderId?['新建会话 · 目录 F','新建目录 · 目录 F','新建临时会话']:['新建根级目录','新建临时会话']);
  assert.deepEqual(items.map(i=>i.divided),folderId?[false,false,true]:[false,true]);
  await items.at(-1).node.props.onClick();
  assert.deepEqual(x.events.at(-1),['new-conversation','']);
  assert.equal(x.s.selectedFolderId.value,folderId,'creation uses the existing parent handler rather than changing selection ahead of draft confirmation');
  if(folderId){await items[0].node.props.onClick();assert.deepEqual(x.events.at(-1),['new-conversation','F']);}
  await items.at(-2).node.props.onClick();assert.deepEqual(folders,[folderId]);
});

for(const phone of [true,false])test(`${phone?'phone':'desktop'} shows a flat recent list or the real tree, never duplicate entries`,async t=>{
  const x=harness(t,{phone});let view=await x.render();
  assert.deepEqual(ids(view),['recent:c']);assert.deepEqual(selected(view),['recent:c']);
  assert.equal(view.nodes.find(n=>classes(n,'tree-list')).props.role,'list');
  assert.equal(rows(view)[0].props.role,'listitem');assert.equal(rows(view)[0].props.draggable,true);
  assert.match(view.html,/目录 F/);assert.doesNotMatch(view.html,/__recent|activity-folder/);
  await view.nodes.find(n=>n.props?.['data-sidebar-view']==='folders').props.onClick();
  view=await x.render();assert.deepEqual(ids(view),['F','c','__temporary','__archive']);assert.deepEqual(selected(view),['c']);
  assert.equal(view.nodes.find(n=>classes(n,'tree-list')).props.role,'tree');assert.equal(rows(view)[1].props['aria-level'],2);
  assert.equal(rows(view)[0].props.draggable,true);assert.ok(!x.s.displayRows.value.some(r=>r.recentAlias));
  assert.equal(x.events.length,0);assert.equal(x.requests.length,0);assert.equal(x.props.activeConversationUuid,'c');assert.equal(x.s.selectedFolderId.value,'chosen');
  assert.equal(view.nodes.filter(n=>classes(n,'tree-list')).length,1);
  assert.equal(view.nodes.filter(n=>n.props?.role==='tab'&&n.props['aria-selected']).length,1);
});

test('switching views preserves each scroll offset, folder expansion and conversation without refetching',async t=>{
  const x=harness(t);x.s.listRef.value={scrollTop:120};
  await x.s.switchSidebarView('folders');await settle();assert.equal(x.s.listRef.value.scrollTop,0);
  x.s.listRef.value.scrollTop=360;x.s.expanded.value=new Set();
  await x.s.switchSidebarView('recent');await settle();assert.equal(x.s.listRef.value.scrollTop,120);
  await x.s.switchSidebarView('folders');await settle();assert.equal(x.s.listRef.value.scrollTop,360);assert.equal(x.s.expanded.value.size,0);
  assert.equal(x.events.length,0);assert.equal(x.requests.length,0);assert.equal(x.props.activeConversationUuid,'c');assert.equal(x.s.selectedFolderId.value,'chosen');
  assert.equal(x.stored.get('openbear:conversation-sidebar-view'),'folders');
});

test('last view is restored, while invalid or unavailable browser storage safely uses recent',async t=>{
  assert.equal(harness(t,{storedView:'folders'}).s.sidebarView.value,'folders');
  assert.equal(harness(t,{storedView:'invalid'}).s.sidebarView.value,'recent');
  const x=harness(t,{blockedStorage:true});assert.equal(x.s.sidebarView.value,'recent');await x.s.switchSidebarView('folders');assert.equal(x.s.sidebarView.value,'folders');
});

test('tab keyboard navigation retains its DOM target across asynchronous rendering and does not open a chat',async t=>{
  const x=harness(t),view=await x.render(),focused=[];
  const event={key:'ArrowRight',preventDefault(){},currentTarget:{querySelector:selector=>({focus:()=>focused.push(selector)})}};
  const job=view.nodes.find(n=>n.props?.role==='tablist').props.onKeydown(event);event.currentTarget=null;await job;
  assert.equal(x.s.sidebarView.value,'folders');assert.deepEqual(focused,['[data-sidebar-view="folders"]']);assert.equal(x.events.length,0);
});

for(const phone of [true,false])test(`${phone?'phone':'desktop'} recent activation preserves folder target, while directory activation keeps normal selection`,async t=>{
  const x=harness(t,{phone});
  await (await x.render()).nodes.find(n=>classes(n,'conversation')).props.onClick();
  const opened=x.events.find(e=>e[0]==='open')[1];assert.equal(opened.conversationUuid,'c');assert.equal(opened.folderId,'F');assert.equal('recentAlias' in opened,false);
  assert.equal(x.s.selectedFolderId.value,'chosen');assert.equal(x.s.sidebarView.value,'recent');assert.equal(x.requests.length,0);
  await x.s.switchSidebarView('folders');await (await x.render()).nodes.find(n=>classes(n,'conversation')).props.onClick();
  assert.equal(x.s.selectedFolderId.value,'F');assert.equal(x.s.stateFor('F').items[0].recentAlias,undefined);
  x.s.recentItems.value=[conversation('c',{lastInteractionAtMs:2000})];x.s.stateFor('F').items=[conversation('c',{lastInteractionAtMs:2000})];
  assert.deepEqual(selected(await x.render()),['c']);await x.s.switchSidebarView('recent');assert.deepEqual(selected(await x.render()),['recent:c']);
});

for(const phone of [true,false])test(`${phone?'phone':'desktop'} recent drag inserts an editor reference but cannot reorder or move a conversation`,async t=>{
  const x=harness(t,{phone}),view=await x.render(),row=rows(view)[0],data=new Map();
  const transfer={setData:(key,value)=>data.set(key,value),getData:key=>data.get(key)||'',get types(){return [...data.keys()];}};
  let prevented=0;
  row.props.onDragstart({dataTransfer:transfer,preventDefault(){prevented++;}});
  const reference={kind:'chat',id:'c',label:'c',scope:'full'};
  assert.equal(row.props.draggable,true);assert.equal(prevented,0);
  assert.equal(transfer.effectAllowed,'copy');assert.equal(x.s.drag.value.row,null);
  assert.deepEqual(JSON.parse(data.get(REFERENCE_MIME)),reference);
  assert.equal(data.get('text/plain'),referenceToken(reference));assert.equal(data.has('application/x-openbear-tree'),false);

  // Feed the actual exported payload through the real editor's receiving handlers.
  const editorSource=fs.readFileSync(new URL('../references/ReferenceEditor.vue',import.meta.url),'utf8'),inserted=[];
  const receiver=vm.createContext({REFERENCE_MIME,dragHover:ref(false),lastSelection:null,
    editor:ref({view:{posAtCoords:()=>({pos:6})}}),insertReference:(value,range)=>inserted.push(JSON.parse(JSON.stringify({value,range}))),
    event:{dataTransfer:transfer,clientX:30,clientY:40,preventDefault(){prevented++;},stopPropagation(){}}});
  vm.runInContext(editorSource.slice(editorSource.indexOf('function dragOver('),editorSource.indexOf('function externalInsert(')),receiver);
  vm.runInContext('dragOver(event);drop(event)',receiver);
  assert.equal(transfer.dropEffect,'copy');assert.equal(receiver.dragHover.value,false);
  assert.deepEqual(inserted,[{value:reference,range:{from:6,to:6}}]);

  const event={dataTransfer:transfer,preventDefault(){},stopPropagation(){},clientY:50,currentTarget:{getBoundingClientRect:()=>({top:0,height:100})}};
  await x.s.drop(event,x.s.displayRows.value[0]);
  assert.equal(x.requests.length,0);assert.equal(x.events.length,0);
  row.props.onDragstart({dataTransfer:transfer,preventDefault(){assert.fail('reference drag unexpectedly blocked');}});
  await x.s.switchSidebarView('folders');
  assert.equal(x.s.dropIntent(event,folder('F')),null);
  await x.s.drop(event,folder('F'));await x.s.drop(event,x.s.rootDropTarget);
  assert.equal(x.requests.length,0);assert.equal(x.s.stateFor('F').items[0].folderId,'F');
  assert.deepEqual(x.s.recentItems.value.map(item=>item.conversationUuid),['c']);
});

test('recent context menu keeps original identity and directory drop remains available only in directory view',async t=>{
  const x=harness(t),alias=x.s.displayRows.value[0];
  const event={preventDefault(){},stopPropagation(){},currentTarget:{getBoundingClientRect:()=>({right:200,bottom:100})}};
  await x.s.openMoreMenu(event,alias);assert.equal(x.s.menu.value.row.conversationUuid,'c');assert.equal('recentAlias' in x.s.menu.value.row,false);
  const other=conversation('other'),destination=folder('destination');
  for(const ratio of [0,.5,1]){assert.equal(resolveTreeDrop(other,alias,ratio,[]),null);assert.equal(resolveTreeDrop(alias,destination,ratio,[]),null);}
  x.s.drag.value.row=other;assert.equal(x.s.dropIntent({},destination),null);
  await x.s.switchSidebarView('folders');x.s.drag.value.row=other;
  assert.equal(x.s.dropIntent({currentTarget:{getBoundingClientRect:()=>({top:0,height:100})},clientY:50},destination).targetFolderId,'destination');
});

for(const phone of [true,false])test(`${phone?'phone':'desktop'} status packets still render fifteen recent conversations without the redundant footer`,async t=>{
  const x=harness(t,{phone});
  x.ctx.statusPacket={items:[],recentItems:Array.from({length:16},(_,i)=>conversation(`recent${i}`,{lastInteractionAtMs:2000-i}))};
  x.run('applyStatus(statusPacket)');await settle();
  assert.equal(x.s.recentItems.value.length,15);
  const view=await x.render();
  assert.deepEqual(ids(view),Array.from({length:15},(_,i)=>`recent:recent${i}`));
  assert.ok(!templateNodes.some(n=>n.tag==='footer'));
});

test('outstanding work, counts and read-all remain accessible in both views',async t=>{
  const x=harness(t);
  x.s.recentItems.value=Array.from({length:7},(_,i)=>conversation(`recent${i}`,{lastInteractionAtMs:1000+i}));
  x.s.activityItems.value=[conversation('wait',{running:true,activityPending:[{action:'confirm'}]}),conversation('unread',{activityUnread:true,activityReadVersion:0}),conversation('running',{running:true,activityState:'running'})];
  await settle();assert.equal(x.s.recentConversationRows.value.length,10); // All seven recents plus three outstanding conversations.
  let view=await x.render();assert.match(view.html,/待确认/);assert.match(view.html,/完成待查看/);
  await x.s.switchSidebarView('folders');view=await x.render();assert.match(view.html,/待处理 1/);assert.match(view.html,/未读 1/);assert.match(view.html,/运行 1/);
  await view.nodes.find(n=>classes(n,'recent-read-all')).props.onClick();assert.equal(x.reads.length,1);assert.equal(x.reads[0].length,1);assert.equal(x.reads[0][0].conversationUuid,'unread');
  x.s.query.value='needle';await settle();
  await (await x.render()).nodes.find(n=>classes(n,'sidebar-activity-summary')).props.onClick();
  assert.equal(x.s.sidebarView.value,'recent');assert.equal(x.s.query.value,'');assert.equal(x.s.recentLabel(conversation('fail',{activityState:'failed'})),'失败');
});

for(const phone of [true,false]) for(const mode of ['recent','folders']) test(`${phone?'phone':'desktop'} ${mode} keeps all counts visible and shows read-all only with unread conversations`,async t=>{
  const x=harness(t,{phone});await x.s.switchSidebarView(mode);
  const states=[
    [[],[0,0,0]],
    [[conversation('job',{running:true,activityState:'running'})],[0,0,1]],
    [[conversation('job',{running:true,activityState:'running',activityUnread:true,activityReadVersion:0})],[0,0,1]],
    [[conversation('job',{running:true,activityPending:[{action:'confirm'}]})],[1,0,0]],
    [[conversation('job',{running:true,activityState:'waiting',activityPending:[{action:'confirm'}],activityUnread:true,activityReadVersion:0})],[1,0,0]],
    [[conversation('job',{activityUnread:true,activityReadVersion:0})],[0,1,0]],
    [[],[0,0,0]],
  ];
  for(const [items,counts] of states){
    x.s.activityItems.value=items;await settle();const view=await x.render();
    const activity=view.nodes.find(n=>classes(n,'sidebar-activity'));assert.ok(activity,'status row stays mounted even when idle');
    assert.equal(walk([activity]).filter(n=>n.type==='span').length,3);
    assert.deepEqual([x.s.recentWaitingCount.value,x.s.recentUnreadCount.value,x.s.recentRunningCount.value],counts);
    assert.match(view.html,new RegExp(`待处理 ${counts[0]}`));assert.match(view.html,new RegExp(`未读 ${counts[1]}`));assert.match(view.html,new RegExp(`运行 ${counts[2]}`));
    const readAll=view.nodes.find(n=>classes(n,'recent-read-all'));
    assert.equal(Boolean(readAll),Boolean(counts[1]),'no invisible button may reserve width when there are no unread conversations');
    if(readAll){
      assert.equal(Boolean(readAll.props.disabled),false);
      x.s.activityReadBusy.value=true;
      assert.equal((await x.render()).nodes.find(n=>classes(n,'recent-read-all')).props.disabled,true);
      x.s.activityReadBusy.value=false;
    }
    assert.equal(x.s.sidebarView.value,mode);assert.equal(x.props.activeConversationUuid,'c');
  }
});

for(const phone of [true,false]) for(const mode of ['recent','folders']) test(`${phone?'phone':'desktop'} ${mode} read-all only acknowledges counted unread rows and retains in-progress results`,async t=>{
  const x=harness(t,{phone});await x.s.switchSidebarView(mode);
  x.s.titleGenerating.value=new Set(['naming']);
  let items=[
    conversation('done',{activityVersion:4,activityReadVersion:3}),
    conversation('working',{running:true,activityState:'running',activityVersion:20,activityReadVersion:18}),
    conversation('waiting',{running:true,activityState:'waiting',activityPending:[{action:'confirm'}],activityReadVersion:0}),
    conversation('naming',{activityReadVersion:0}),
  ];
  const apply=async()=>{
    x.ctx.statusPacket={items:items.filter(row=>row.running),activityItems:items,recentItems:items};
    x.run('applyStatus(statusPacket)');await settle();
  };
  const counts=()=>[x.s.recentWaitingCount.value,x.s.recentUnreadCount.value,x.s.recentRunningCount.value];
  const clickReadAll=async()=>{await (await x.render()).nodes.find(n=>classes(n,'recent-read-all')).props.onClick();};
  const requests=()=>JSON.parse(JSON.stringify(x.reads.at(-1)));
  await apply();
  assert.deepEqual(counts(),[1,1,1]);
  await clickReadAll();assert.deepEqual(requests(),[{conversationUuid:'done',version:4}]);
  for(const id of ['working','waiting','naming']){
    assert.equal(x.s.recentConversationRows.value.find(row=>row.conversationUuid===id).activityUnread,true,'hiding a marker must not consume the result');
  }
  // A server read receipt clears only the completed conversation.
  items=items.map(row=>row.conversationUuid==='done'?{...row,activityReadVersion:4}:row);
  await apply();assert.deepEqual(counts(),[1,0,1]);
  assert.ok(!(await x.render()).nodes.some(n=>classes(n,'recent-read-all')));
  // When the parent run finishes, its new completion becomes visible as unread.
  items=items.map(row=>row.conversationUuid==='working'?{...row,running:false,activityState:'completed',activityVersion:21}:row);
  await apply();assert.deepEqual(counts(),[1,1,0]);
  await clickReadAll();assert.deepEqual(requests(),[{conversationUuid:'working',version:21}]);
  items=items.map(row=>row.conversationUuid==='working'?{...row,activityReadVersion:21}:row);
  await apply();assert.deepEqual(counts(),[1,0,0]);
  assert.ok(!(await x.render()).nodes.some(n=>classes(n,'recent-read-all')));
});

test('status geometry keeps breakpoint heights and spreads counts across the available width',()=>{
  const css=postcss.parse(descriptor.styles[0].content),heights=[];
  css.walkRules('.sidebar-activity',r=>r.walkDecls('height',d=>heights.push([r.parent.type==='root'?'base':r.parent.params,d.value])));
  assert.deepEqual(heights,[['base','27px'],['(max-width:760px), (hover:none) and (pointer:coarse)','44px']]);
  css.walkRules('.sidebar-activity-summary',r=>{
    assert.ok(r.nodes.some(d=>d.prop==='flex-wrap'&&d.value==='nowrap'));
    assert.ok(r.nodes.some(d=>d.prop==='white-space'&&d.value==='nowrap'));
    assert.ok(r.nodes.some(d=>d.prop==='font-variant-numeric'&&d.value==='tabular-nums'));
    assert.ok(r.nodes.some(d=>d.prop==='flex'&&d.value==='1'));
    assert.ok(r.nodes.some(d=>d.prop==='justify-content'&&d.value==='space-between'));
  });
});

test('global search has its own scroll state; clearing restores the chosen view without changing the chat',async t=>{
  const x=harness(t);x.s.listRef.value={scrollTop:70};
  x.s.query.value='needle';x.s.searchRows.value=[conversation('c'),conversation('result')];await settle();
  assert.equal(x.s.listRef.value.scrollTop,0);assert.deepEqual(ids(await x.render()),['c','result']);assert.deepEqual(selected(await x.render()),['c']);
  x.s.listRef.value.scrollTop=25;await x.s.switchSidebarView('folders');await settle();assert.equal(x.s.listRef.value.scrollTop,25);
  x.s.query.value='';await settle();assert.equal(x.s.listRef.value.scrollTop,0);assert.deepEqual(ids(await x.render()),['F','c','__temporary','__archive']);
  await x.s.switchSidebarView('recent');await settle();assert.equal(x.s.listRef.value.scrollTop,70);assert.equal(x.props.activeConversationUuid,'c');
  assert.equal(x.events.length,0);assert.equal(x.requests.length,0);
});

test('search result activation opens the result while remaining in the chosen navigation view',async t=>{
  const x=harness(t);x.s.query.value='other';x.s.searchRows.value=[conversation('other')];await settle();
  await (await x.render()).nodes.find(n=>classes(n,'conversation')).props.onClick();
  assert.equal(x.events.find(e=>e[0]==='open')[1].conversationUuid,'other');assert.equal(x.s.sidebarView.value,'recent');
  x.props.activeConversationUuid='other';assert.deepEqual(selected(await x.render()),['other']);
  x.s.query.value='';x.s.recentItems.value=[conversation('other')];assert.deepEqual(selected(await x.render()),['recent:other']);
  x.props.activeConversationUuid='not-loaded';assert.deepEqual(selected(await x.render()),[]);
});

test('recent menu locate still reveals its conversation in folders without opening a different one',async t=>{
  const x=harness(t),row=x.s.displayRows.value[0];x.s.expanded.value=new Set();x.s.query.value='needle';await settle();
  await x.s.openMenu({preventDefault(){},stopPropagation(){}},row);
  await x.s.runMenuAction('locate');
  assert.equal(x.s.sidebarView.value,'folders');assert.equal(x.s.query.value,'');assert.equal(x.s.expanded.value.has('F'),true);
  assert.deepEqual(x.requests.filter(r=>r[0]==='bootstrap'),[['bootstrap','c']]);assert.equal(x.events.some(e=>e[0]==='open'),false);assert.equal(x.props.activeConversationUuid,'c');
  assert.ok(x.scrolled.includes('[data-tree-id="c"]'));assert.deepEqual(selected(await x.render()),['c']);assert.equal(x.s.locatingConversation.value,false);
});

test('a new local draft is revealed in the real directory rather than disappearing from recents',async t=>{
  const x=harness(t);x.props.draftConversation=conversation('local:new',{local:true});x.props.activeConversationUuid='local:new';await settle();
  await x.s.revealDraft('F');assert.equal(x.s.sidebarView.value,'folders');assert.equal(x.s.selectedFolderId.value,'F');
  assert.ok(ids(await x.render()).includes('local:new'));assert.deepEqual(selected(await x.render()),['local:new']);assert.ok(x.scrolled.includes('[data-tree-id="local:new"]'));
});

test('folder search result opens its directory view, not a fictitious recent branch',async t=>{
  const x=harness(t);x.s.query.value='F';x.s.searchRows.value=[folder('F')];await settle();
  await (await x.render()).nodes.find(n=>classes(n,'tree-node-main')).props.onClick();
  assert.equal(x.s.sidebarView.value,'folders');assert.equal(x.s.query.value,'');assert.equal(x.s.selectedFolderId.value,'F');assert.equal(x.props.activeConversationUuid,'c');assert.equal(x.events.some(e=>e[0]==='open'),false);
});

test('empty recent view, shared clock and lifecycle cleanup work without breakpoint listeners',async t=>{
  const x=harness(t);x.s.recentItems.value=[];assert.match((await x.render()).html,/暂无最近会话/);
  x.run('refreshTree=async()=>{};scheduleStatus=()=>{}');await Promise.all(x.mounted.map(fn=>fn()));assert.equal(x.intervals.size,1);
  x.s.recentClock.value=0;x.intervals.get(1)();assert.ok(x.s.recentClock.value>0);
  x.unmounted.forEach(fn=>fn());assert.equal(x.intervals.size,0);
});

test('compiled navigation keeps one scroller, fixed controls, shared theme tokens and touch targets',()=>{
  assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:'ConversationTree.vue',id:'sidebar-views'}).errors,[]);
  assert.equal(templateNodes.filter(n=>n.props?.some(p=>p.name==='ref'&&p.value?.content==='listRef')).length,1);
  assert.ok(!templateNodes.some(n=>n.tag==='ConversationActivityFolder'));
  const css=postcss.parse(descriptor.styles[0].content);let overflow,minHeight,flex;
  css.walkRules('.tree-list',r=>r.walkDecls('overflow',d=>overflow=d.value));assert.equal(overflow,'auto');
  css.walkRules('.sidebar-panel',r=>{r.walkDecls('min-height',d=>minHeight=d.value);r.walkDecls('flex',d=>flex=d.value);});assert.equal(minHeight,'0');assert.equal(flex,'1');
  const touch=[];css.walkAtRules('media',r=>{if(r.params.includes('max-width:760px'))r.walkRules(rule=>{if(rule.selector.includes('.sidebar-tabs button'))rule.walkDecls('min-height',d=>touch.push(d.value));});});assert.ok(touch.includes('44px'));
  assert.match(descriptor.styles[0].content,/\.sidebar-tabs button\[aria-selected="true"\].*var\(--ob-surface-raised\)/);
});


const runningMarkerIds = view => rows(view).filter(row => walk([row]).some(node => classes(node, 'running-leaf'))).map(row => row.props['data-tree-id']);

for (const phone of [true, false]) for (const location of ['F', 'deep']) {
  test(`${phone ? 'phone' : 'desktop'} collapsed folder follows ${location === 'F' ? 'direct' : 'multi-level'} unloaded running descendants through existing status updates`, async t => {
    const x = harness(t, {phone, storedView: 'folders'}), branch = x.s.stateFor('F');
    x.s.rootFolders.value = [{...folder('F'), pinned: true}, folder('idle')];
    x.s.expanded.value = new Set();
    branch.items = []; branch.loaded = false; branch.pages = 0;
    assert.deepEqual(runningMarkerIds(await x.render()), []);

    const active = conversation('unloaded', {folderId: location, running: true, activityState: 'running'});
    x.catalog.treeStatus = {items: [active], folderRunningCounts: location === 'F' ? {F: 1} : {F: 1, sub: 1, deep: 1}};
    await settle();
    let view = await x.render();
    assert.deepEqual(runningMarkerIds(view), ['F']);
    assert.deepEqual(ids(view), ['F', 'idle', '__temporary', '__archive']);
    const root = rows(view)[0], children = walk([root]);
    assert.equal(root.props['aria-expanded'], 'false');
    assert.equal(children.find(node => classes(node, 'running-leaf')).props['aria-label'], '运行中 1 个会话（运行中 1）');
    assert.equal(children.filter(node => classes(node, 'node-count')).length, 1);
    assert.equal(children.find(node => classes(node, 'node-count')).children, '1');
    assert.ok(children.some(node => classes(node, 'node-star')));
    assert.equal(branch.loaded, false); assert.equal(branch.items.length, 0);
    assert.equal(x.requests.filter(request => request[0] !== 'folders').length, 0, 'only complete metadata, never descendants, is fetched');

    // Completion may remain unread, but it is not a running descendant.
    const done = conversation('unloaded', {folderId: location, activityVersion: 2, activityReadVersion: 1});
    x.catalog.treeStatus = {items: [], activityItems: [done], folderRunningCounts: {}};
    await settle(); view = await x.render();
    assert.deepEqual(runningMarkerIds(view), []);
    assert.match(view.html, /conversation-unread-dot/);
    assert.equal(branch.loaded, false); assert.equal(branch.items.length, 0);
    assert.equal(x.s.expanded.value.size, 0); assert.equal(x.s.selectedFolderId.value, 'chosen');
    assert.equal(x.requests.filter(request => request[0] !== 'folders').length, 0);
    assert.equal(x.requests.filter(request => request[0] === 'folders').length, 1);
  });
}

test('expanded ancestors keep leaf running/waiting/unread semantics while collapsed nested folders reuse the running dot', async t => {
  const x = harness(t, {storedView: 'folders'});
  x.s.stateFor('F').items = [conversation('c', {pinned: true}), {...folder('sub'), parentId: 'F'}];
  x.s.stateFor('sub').items = [{...folder('deep'), parentId: 'sub'}]; x.s.stateFor('sub').loaded = true;
  x.s.stateFor('deep').items = [conversation('nested', {folderId: 'deep'})]; x.s.stateFor('deep').loaded = true;
  x.s.expanded.value = new Set(['F', 'sub']);
  const direct = conversation('c', {running: true, activityState: 'waiting', activityVersion: 2,
    activityPending: [{interactionId: 'confirm-1', action: 'confirm'}], currentStatus: '待确认'});
  const nested = conversation('nested', {folderId: 'deep', running: true, activityState: 'running'});
  x.catalog.treeStatus = {items: [direct, nested], folderRunningCounts: {F: 2, sub: 1, deep: 1}};
  await settle();
  let view = await x.render();
  assert.deepEqual(runningMarkerIds(view), ['c', 'deep']);
  const directNodes = walk([rows(view).find(row => row.props['data-tree-id'] === 'c')]);
  assert.equal(directNodes.filter(node => classes(node, 'running-leaf')).length, 1);
  assert.ok(directNodes.some(node => classes(node, 'is-working')));
  assert.ok(!directNodes.some(node => classes(node, 'conversation-unread-dot')));
  assert.equal(directNodes.find(node => classes(node, 'running-leaf')).props.title, '待确认 · 未读');

  await x.s.toggleRow(x.s.displayRows.value.find(row => row.folderId === 'F' && row.kind === 'folder'));
  assert.deepEqual(runningMarkerIds(await x.render()), ['F']);
  await x.s.toggleRow(x.s.displayRows.value.find(row => row.folderId === 'F' && row.kind === 'folder'));
  assert.deepEqual(runningMarkerIds(await x.render()), ['c', 'deep']);
  await x.s.toggleRow(x.s.displayRows.value.find(row => row.folderId === 'sub' && row.kind === 'folder'));
  assert.deepEqual(runningMarkerIds(await x.render()), ['c', 'sub']);
  await x.s.toggleRow(x.s.displayRows.value.find(row => row.folderId === 'sub' && row.kind === 'folder'));
  await x.s.toggleRow(x.s.displayRows.value.find(row => row.folderId === 'deep' && row.kind === 'folder'));
  assert.deepEqual(runningMarkerIds(await x.render()), ['c', 'nested']);

  x.catalog.treeStatus = {items: [], activityItems: [{...direct, running: false, activityPending: [], activityState: 'completed'}], folderRunningCounts: {}};
  await settle(); view = await x.render();
  assert.deepEqual(runningMarkerIds(view), []);
  const finished = walk([rows(view).find(row => row.props['data-tree-id'] === 'c')]);
  assert.ok(finished.some(node => classes(node, 'conversation-unread-dot')));
  assert.ok(finished.some(node => classes(node, 'node-star')));
  assert.ok(!finished.some(node => classes(node, 'is-working')));
  assert.equal(x.requests.filter(request => request[0] !== 'folders').length, 0); assert.equal(x.s.selectedFolderId.value, 'chosen');
  assert.equal(x.events.some(event => event[0] === 'open'), false);
});


const temporaryConversation = (id, extra = {}) => conversation(id, {folderId: '', parentId: '', path: '临时会话', ...extra});

for (const phone of [true, false]) for (const transport of ['push', 'poll']) {
  test(`${phone ? 'phone' : 'desktop'} temporary folder reacts to ${transport} with unloaded children and retains its dot until the last running conversation ends`, async t => {
    const x = harness(t, {phone, storedView: 'folders'}), branch = x.s.stateFor('', 'temporary');
    x.s.expanded.value = new Set();
    const inFolder = conversation('in-folder', {running: true, activityState: 'running'});
    const done = temporaryConversation('done', {activityVersion: 2, activityReadVersion: 1});
    const archived = temporaryConversation('archived', {running: true, archived: true});
    const first = temporaryConversation('first', {running: true, activityState: 'running'});
    const second = temporaryConversation('second', {running: true, activityState: 'waiting',
      activityPending: [{interactionId: 'confirm-temp', action: 'confirm'}]});
    async function status(running) {
      const packet = {items: [inFolder, ...running], activityItems: [inFolder, done, archived, ...running],
        recentItems: [], folderRunningCounts: {F: 1}};
      if (transport === 'push') x.catalog.treeStatus = packet;
      else {
        x.api.conversationTreeStatus = async () => {x.requests.push(['status']); return packet;};
        await x.run('refreshStatus()');
      }
      await settle();
      return x.render();
    }
    let view = await status([]);
    assert.deepEqual(runningMarkerIds(view), ['F'], 'real-folder, completed-unread and archived activity must not mark temporary as running');
    view = await status([first, second]);
    assert.deepEqual(runningMarkerIds(view), ['F', '__temporary']);
    assert.deepEqual(ids(view), ['F', '__temporary', '__archive']);
    const temporary = rows(view).find(row => row.props['data-tree-id'] === '__temporary');
    assert.equal(temporary.props['aria-expanded'], 'false');
    assert.equal(walk([temporary]).filter(node => classes(node, 'running-leaf')).length, 1);
    assert.equal(branch.loaded, false); assert.equal(branch.items.length, 0);
    view = await status([second]);
    assert.deepEqual(runningMarkerIds(view), ['F']);
    assert.deepEqual(directoryDots(view, '__temporary').map(node => node.props.class), ['directory-waiting-dot', 'conversation-unread-dot']);
    view = await status([]);
    assert.deepEqual(runningMarkerIds(view), ['F']);
    assert.equal(branch.loaded, false); assert.equal(branch.items.length, 0);
    assert.equal(x.s.expanded.value.size, 0); assert.equal(x.s.selectedFolderId.value, 'chosen');
    assert.equal(x.requests.filter(request => !['status','folders'].includes(request[0])).length, 0);
    assert.equal(x.requests.filter(request => request[0] === 'status').length, transport === 'poll' ? 4 : 0);
    assert.equal(x.requests.filter(request => request[0] === 'folders').length, 1);
  });
}

for (const phone of [true, false]) test(`${phone ? 'phone' : 'desktop'} bootstrap temporary running state keeps existing expansion and leaf semantics, then lights the collapsed system folder`, async t => {
  const x = harness(t, {phone, storedView: 'folders'});
  const active = temporaryConversation('bootstrap-temp', {running: true, activityState: 'waiting',
    activityVersion: 2, activityPending: [{interactionId: 'confirm-bootstrap', action: 'confirm'}], currentStatus: '待确认'});
  x.api.conversationTreeBootstrap = async () => {
    x.requests.push(['bootstrap']);
    return {rootFolders: [folder('F')], activeCount: 3, temporaryCount: 2,
      running: {items: [active], activityItems: [active], folderRunningCounts: {}}};
  };
  x.api.conversationTreeChildren = async options => {
    x.requests.push(['children', options]);
    assert.equal(options.systemNode, 'temporary');
    return {items: [active], hasMore: false};
  };
  await x.run('refreshTree({preserve: false, trackActive: false})'); await settle();
  let view = await x.render();
  assert.deepEqual(runningMarkerIds(view), ['bootstrap-temp']);
  const leaf = rows(view).find(row => row.props['data-tree-id'] === 'bootstrap-temp');
  assert.ok(walk([leaf]).some(node => classes(node, 'is-working')));
  assert.equal(walk([leaf]).find(node => classes(node, 'running-leaf')).props.title, '待确认 · 未读');
  const systemRow = () => x.s.displayRows.value.find(row => row.id === '__temporary');
  await x.s.toggleRow(systemRow()); view = await x.render();
  assert.deepEqual(runningMarkerIds(view), []);
  assert.deepEqual(directoryDots(view, '__temporary').map(node => node.props.class), ['directory-waiting-dot','conversation-unread-dot']);
  const systemNodes = walk([rows(view).find(row => row.props['data-tree-id'] === '__temporary')]);
  assert.equal(systemNodes.find(node => classes(node, 'node-count')).children, '2');
  await x.s.toggleRow(systemRow());
  assert.deepEqual(runningMarkerIds(await x.render()), ['bootstrap-temp']);
  x.catalog.treeStatus = {items: [], activityItems: [{...active, running: false, activityState: 'completed', activityPending: []}], folderRunningCounts: {}};
  await settle(); view = await x.render();
  assert.deepEqual(runningMarkerIds(view), []);
  assert.ok(walk([rows(view).find(row => row.props['data-tree-id'] === 'bootstrap-temp')]).some(node => classes(node, 'conversation-unread-dot')));
  await x.s.toggleRow(systemRow());
  assert.deepEqual(runningMarkerIds(await x.render()), []);
  assert.equal(x.requests.length, 2, 'only the existing bootstrap and initial temporary children load are needed');
});


const directoryDots = (view, id) => walk([rows(view).find(row => row.props['data-tree-id'] === id)])
  .filter(node => ['directory-waiting-dot', 'running-leaf', 'conversation-unread-dot'].some(name => classes(node, name)));
const directoryGroup = (view, id) => walk([rows(view).find(row => row.props['data-tree-id'] === id)]).find(node => classes(node, 'directory-activity'));
const resultRow = (id, state = 'completed', extra = {}) => conversation(id, {folderId: 'deep', activityState: state,
  activityVersion: 3, activityReadVersion: 2, activityResult: {status: state}, ...extra});
const statusPacket = activityItems => ({activityItems, items: activityItems.filter(row => row.running && !row.archived),
  folderConversationCounts: {F: 20, sub: 20, deep: 20, other: 0, '': 5}, folderRunningCounts: {}});

for (const phone of [true, false]) test(`${phone ? 'phone' : 'desktop'} directory activity aggregates all unloaded descendants by IDs with three parallel categories and complete labels`, async t => {
  const x = harness(t, {phone, storedView: 'folders'});
  x.s.rootFolders.value = [{...folder('F'), name: 'same / name', pinned: true, conversationCount: 20}, {...folder('other'), name: 'same / name'}];
  x.s.expanded.value = new Set(); x.s.stateFor('F').items = []; x.s.stateFor('F').loaded = false;
  const activities = [conversation('run', {folderId: 'deep', running: true, activityState: 'running'}),
    conversation('wait', {folderId: 'deep', running: true, activityState: 'waiting', activityVersion: 3,
      activityResult: {status: 'completed'}, activityPending: [{action: 'confirm'}, {action: 'select'}, {action: 'prompt'}, {action: 'questionnaire'}]}),
    conversation('generic-wait', {folderId: 'deep', running: true, activityState: 'waiting'}),
    ...['completed','failed','error','cancelled','interrupted','partial'].map((state, i) => resultRow(`result-${i}`, state)),
    resultRow('archived', 'failed', {archived: true}),
    temporaryConversation('temp-run', {running: true, activityState: 'running'}),
    temporaryConversation('temp-wait', {running: true, activityState: 'waiting', activityPending: [{action: 'confirm'}]}),
    resultRow('temp-result', 'interrupted', {folderId: ''})];
  x.catalog.treeStatus = statusPacket(activities); await settle();
  const view = await x.render();
  for (const id of ['F','__temporary']) {
    assert.deepEqual(directoryDots(view, id).map(node => node.props.class), ['directory-waiting-dot','running-leaf','conversation-unread-dot']);
    assert.ok(directoryGroup(view,id).props.title.includes('运行中'));
    assert.equal(directoryGroup(view,id).props['aria-label'], directoryGroup(view,id).props.title);
  }
  const summary = directoryGroup(view,'F').props.title;
  for (const label of ['待确认','待选择','待填写','待填写问卷','待处理','运行中','已完成','失败','已取消','已中断','部分完成','未读']) assert.ok(summary.includes(label), label);
  assert.match(summary, /失败 2/);
  assert.equal(directoryDots(view,'other').length,0); assert.equal(directoryDots(view,'__archive').length,0);
  assert.equal(x.s.stateFor('F').loaded,false); assert.equal(x.s.stateFor('F').items.length,0);
  assert.equal(x.requests.filter(request=>request[0]==='folders').length,1);
  assert.equal(x.requests.filter(request=>request[0]==='children'||request[0]==='locate').length,0);
  assert.equal(walk([rows(view)[0]]).find(node=>classes(node,'node-count')).children,'20');
  assert.ok(walk([rows(view)[0]]).some(node=>classes(node,'node-star')));
  x.s.stateFor('F').items=[{...folder('sub'),parentId:'F'}];x.s.expanded.value=new Set(['F']);
  let expanded=await x.render();assert.equal(directoryDots(expanded,'F').length,0);assert.equal(directoryDots(expanded,'sub').length,3);
  x.s.stateFor('sub').items=[{...folder('deep'),parentId:'sub'}];x.s.expanded.value=new Set(['F','sub']);
  expanded=await x.render();assert.equal(directoryDots(expanded,'sub').length,0);assert.equal(directoryDots(expanded,'deep').length,3);
});

for (const phone of [true,false]) test(`${phone ? 'phone' : 'desktop'} directory categories clear independently and read receipts only cover the exact conversation/version`, async t => {
  const x=harness(t,{phone,storedView:'folders'}); x.s.expanded.value=new Set();
  const update=async items=>{x.catalog.treeStatus=statusPacket(items);await settle();return x.render();};
  assert.equal(directoryDots(await update([]),'F').length,0);
  let view=await update([conversation('active',{folderId:'deep',running:true,activityState:'waiting',activityPending:[{action:'prompt'}]})]);
  assert.deepEqual(directoryDots(view,'F').map(node=>node.props.class),['directory-waiting-dot']);
  view=await update([resultRow('active','completed',{running:true,activityState:'running'})]);
  assert.deepEqual(directoryDots(view,'F').map(node=>node.props.class),['running-leaf','conversation-unread-dot']);
  view=await update([resultRow('active','failed')]);
  assert.deepEqual(directoryDots(view,'F').map(node=>node.props.class),['conversation-unread-dot']);
  x.catalog.activityReadVersions=new Map([['unrelated',99],['active',2]]);await settle();
  assert.equal(directoryDots(await x.render(),'F').length,1);
  x.catalog.activityReadVersions=new Map([['active',3]]);await settle();
  assert.equal(directoryDots(await x.render(),'F').length,0);
  view=await update([resultRow('active','partial',{activityVersion:4})]);
  assert.equal(directoryDots(view,'F').length,1,'a receipt for version 3 cannot cover a new result');
  x.s.expanded.value=new Set(['F']);await settle();assert.equal(directoryDots(await x.render(),'F').length,0);
  x.s.expanded.value=new Set();await settle();assert.equal(directoryDots(await x.render(),'F').length,1,'expansion does not acknowledge results');
  x.catalog.activityReadVersions=new Map([['active',4]]);await settle();assert.equal(directoryDots(await x.render(),'F').length,0);
});

test('directory metadata refreshes for remote structural changes, not status/message/read updates, even with duplicate display paths',async t=>{
  const x=harness(t,{storedView:'folders'});x.s.rootFolders.value=[folder('F'),folder('other')];x.s.expanded.value=new Set();
  let parent='F';x.api.conversationTreeFolders=async()=>{x.requests.push(['folders']);return {items:[{folderId:'F',parentId:'',name:'same / name',path:'same / name'},
    {folderId:'other',parentId:'',name:'same / name',path:'same / name'}, {folderId:'deep',parentId:parent,name:'same',path:'identical / display'}]};};
  const done=resultRow('done');x.catalog.treeStatus=statusPacket([done]);await settle();
  assert.equal(directoryDots(await x.render(),'F').length,1);assert.equal(x.requests.length,1);
  for(let i=0;i<4;i++){x.catalog.treeStatus={...statusPacket([{...done,currentStatus:`message ${i}`}]),revision:i};await settle();}
  assert.equal(x.requests.length,1,'message/status packets reuse the full folder metadata');
  parent='other';x.catalog.treeStatus={...statusPacket([done]),folderConversationCounts:{F:0,other:20,deep:20,'':5}};await settle();
  let view=await x.render();assert.equal(directoryDots(view,'F').length,0);assert.equal(directoryDots(view,'other').length,1);assert.equal(x.requests.length,2);
  x.catalog.treeStatus={...statusPacket([]),folderConversationCounts:{F:0,other:20,deep:20,'':5}};await settle();
  assert.equal(directoryDots(await x.render(),'other').length,0,'remote archive/removal clears unread activity');
});

test('local conversation and folder moves update directory summaries without waiting for another status packet',async t=>{
  const x=harness(t,{storedView:'folders'});x.s.rootFolders.value=[folder('F'),folder('other')];x.s.expanded.value=new Set();
  x.catalog.treeStatus=statusPacket([resultRow('moved')]);await settle();assert.equal(directoryDots(await x.render(),'F').length,1);
  await x.run(`applyMoveOrganization(activityItems.value[0], '', {item:{...activityItems.value[0],folderId:'',parentId:'',path:'临时会话'},folderPath:[],folderItems:[]})`);await settle();
  let view=await x.render();assert.equal(directoryDots(view,'F').length,0);assert.equal(directoryDots(view,'__temporary').length,1);
  await x.run(`applyMoveOrganization(activityItems.value[0], 'deep', {item:{...activityItems.value[0],folderId:'deep',parentId:'deep'},folderPath:['F','sub','deep'],folderItems:[]})`);await settle();
  assert.equal(directoryDots(await x.render(),'F').length,1);
  await x.run(`applyMoveOrganization({kind:'folder',folderId:'sub',parentId:'F',path:'same'}, 'other', {item:{kind:'folder',folderId:'sub',parentId:'other',name:'same',path:'same'},folderPath:['other','sub'],folderItems:[{kind:'folder',folderId:'other',parentId:'',name:'same'}]})`);await settle();
  view=await x.render();assert.equal(directoryDots(view,'F').length,0);assert.equal(directoryDots(view,'other').length,1);
  await x.run(`adoptStatusConversation({...activityItems.value[0],archived:true})`);await settle();
  assert.equal(directoryDots(await x.render(),'other').length,0);
});

test('bootstrap unread descendants use complete metadata without expanding or marking them read',async t=>{
  const x=harness(t,{storedView:'folders'});
  x.api.conversationTreeBootstrap=async()=>({rootFolders:[folder('F')],activeCount:20,running:statusPacket([resultRow('bootstrap-unread','interrupted')])});
  await x.run('refreshTree({preserve:false,trackActive:false})');await settle();
  assert.deepEqual(directoryDots(await x.render(),'F').map(node=>node.props.class),['conversation-unread-dot']);
  assert.equal(x.s.expanded.value.size,0);assert.equal(x.reads.length,0);assert.equal(x.requests.filter(request=>request[0]==='children').length,0);
});


test('in-flight metadata requests are single-flight and an obsolete structure response cannot restore old ancestors',async t=>{
  const x=harness(t,{storedView:'folders'});x.s.rootFolders.value=[folder('F'),folder('other')];x.s.expanded.value=new Set();
  let resolve;const old=new Promise(done=>{resolve=done;});
  x.api.conversationTreeFolders=async()=>{x.requests.push(['folders']);return x.requests.length===1?old:{items:[{folderId:'F',parentId:''},{folderId:'other',parentId:''},{folderId:'deep',parentId:'other'}]};};
  x.catalog.treeStatus=statusPacket([resultRow('pending')]);await settle();
  for(let i=0;i<3;i++){x.catalog.treeStatus={...statusPacket([resultRow('pending')]),revision:i};await settle();}
  assert.equal(x.requests.length,1);
  x.catalog.treeStatus={...statusPacket([resultRow('pending')]),folderConversationCounts:{F:0,other:20,deep:20}};await settle();
  assert.equal(x.requests.length,1);
  resolve({items:[{folderId:'F',parentId:''},{folderId:'other',parentId:''},{folderId:'deep',parentId:'F'}]});
  await x.run('loadAllFolders(false)');await settle();
  const view=await x.render();assert.equal(directoryDots(view,'F').length,0);assert.equal(directoryDots(view,'other').length,1);assert.equal(x.requests.length,2);
});

test('complete running items stay represented when the recent/activity alias list omits them',async t=>{
  const x=harness(t,{storedView:'folders'});x.s.expanded.value=new Set();
  x.catalog.treeStatus={...statusPacket([]),items:[conversation('background',{folderId:'deep',running:true,activityState:'waiting',activityPending:[{action:'questionnaire'}]})]};
  await settle();const view=await x.render();
  assert.deepEqual(directoryDots(view,'F').map(node=>node.props.class),['directory-waiting-dot']);
  assert.match(directoryGroup(view,'F').props.title,/待填写问卷/);
});

for(const folderId of ['deep',''])test(`${folderId||'temporary'} multiple unread conversations survive another receipt and clear only after the last one is read`,async t=>{
  const x=harness(t,{storedView:'folders'});x.s.expanded.value=new Set();
  x.catalog.treeStatus=statusPacket([resultRow('one','failed',{folderId}),resultRow('two','interrupted',{folderId})]);await settle();
  const id=folderId?'F':'__temporary';assert.match(directoryGroup(await x.render(),id).props.title,/未读 2 个会话/);
  x.catalog.activityReadVersions=new Map([['one',3]]);await settle();assert.match(directoryGroup(await x.render(),id).props.title,/未读 1 个会话/);
  x.catalog.activityReadVersions=new Map([['one',3],['two',3]]);await settle();assert.equal(directoryDots(await x.render(),id).length,0);
});


test('coalesced remote structural moves with unchanged counts refresh ID metadata when activity paths change',async t=>{
  const x=harness(t,{storedView:'folders'});x.s.rootFolders.value=[folder('F'),folder('other')];x.s.expanded.value=new Set();
  let parent='F';x.api.conversationTreeFolders=async()=>{x.requests.push(['folders']);return {items:[{folderId:'F',parentId:''},{folderId:'other',parentId:''},{folderId:'deep',parentId:parent}]};};
  x.catalog.treeStatus=statusPacket([resultRow('move','completed',{path:'old / display'})]);await settle();assert.equal(directoryDots(await x.render(),'F').length,1);
  parent='other';x.catalog.treeStatus=statusPacket([resultRow('move','completed',{path:'new / display'})]);await settle();
  const view=await x.render();assert.equal(directoryDots(view,'F').length,0);assert.equal(directoryDots(view,'other').length,1);assert.equal(x.requests.length,2);
});

test('a pre-move poll cannot overwrite a locally adopted activity location',async t=>{
  const x=harness(t,{storedView:'folders'});x.s.expanded.value=new Set();x.catalog.treeStatus=statusPacket([resultRow('moved')]);await settle();
  let resolve;x.api.conversationTreeStatus=()=>new Promise(done=>{resolve=done;});const poll=x.run('refreshStatus()');
  await x.run(`applyMoveOrganization(activityItems.value[0], '', {item:{...activityItems.value[0],folderId:'',parentId:''},folderPath:[],folderItems:[]})`);await settle();
  resolve(statusPacket([resultRow('moved')]));await poll;await settle();const view=await x.render();
  assert.equal(directoryDots(view,'F').length,0);assert.equal(directoryDots(view,'__temporary').length,1);
});

for(const read of [2,3])test(`restoring an unread archived conversation respects receipt version ${read}`,async t=>{
  const x=harness(t,{storedView:'folders'});x.s.expanded.value=new Set();x.catalog.treeStatus=statusPacket([]);x.catalog.activityReadVersions=new Map([['restored',read]]);await settle();
  const archived=resultRow('restored','failed',{archived:true});
  await x.run(`applyMoveOrganization(${JSON.stringify(archived)}, 'deep', {item:${JSON.stringify({...archived,archived:false})},folderPath:['F','sub','deep'],folderItems:[{kind:'folder',folderId:'F',parentId:''},{kind:'folder',folderId:'sub',parentId:'F'},{kind:'folder',folderId:'deep',parentId:'sub'}]})`);await settle();
  assert.equal(directoryDots(await x.render(),'F').length,read===2?1:0);
});


async function advanceMetadataClock(x,clock,ms){
  clock.now+=ms;
  for(let i=0;i<20;i++){
    const due=[...x.timeouts].filter(([,timer])=>timer.at<=clock.now).sort((a,b)=>a[1].at-b[1].at)[0];
    if(!due)break;x.timeouts.delete(due[0]);due[1].fn();await settle();
  }
  await settle();
}
function calibrationFixture(t){
  const clock={now:100000},x=harness(t,{storedView:'folders',clock});
  x.s.rootFolders.value=[folder('F'),folder('other')];x.s.expanded.value=new Set();
  let parent='F';x.api.conversationTreeFolders=async()=>{x.requests.push(['folders']);return {items:[{folderId:'F',parentId:'',name:'same'},
    {folderId:'other',parentId:'',name:'same'},{folderId:'deep',parentId:parent,name:'same'}]};};
  return {x,clock,move:()=>{parent=parent==='F'?'other':'F';}};
}

test('60-second metadata calibration corrects an eventless same-name ancestor swap without polling every status',async t=>{
  const {x,clock,move}=calibrationFixture(t);
  x.catalog.treeStatus=statusPacket([resultRow('silent-swap')]);await settle();assert.equal(x.requests.length,1);
  move();for(let i=0;i<4;i++){x.catalog.treeStatus={...statusPacket([resultRow('silent-swap')]),revision:i};await settle();}
  assert.equal(x.requests.length,1);assert.equal(directoryDots(await x.render(),'F').length,1);
  await advanceMetadataClock(x,clock,59999);assert.equal(x.requests.length,1);
  await advanceMetadataClock(x,clock,1);assert.equal(x.requests.length,2);
  let view=await x.render();assert.equal(directoryDots(view,'F').length,0);assert.equal(directoryDots(view,'other').length,1);
  await advanceMetadataClock(x,clock,59999);assert.equal(x.requests.length,2);
  await advanceMetadataClock(x,clock,1);assert.equal(x.requests.length,3);assert.equal(x.timeouts.size,1);
});


test('metadata calibration pauses while hidden, recent/search is selected, or activity is empty, and resumes stale caches immediately',async t=>{
  const {x,clock}=calibrationFixture(t);
  x.run('refreshTree=async()=>{};scheduleStatus=()=>{}');await Promise.all(x.mounted.map(fn=>fn()));
  x.api.conversationTreeSearch=async()=>({items:[],hasMore:false});
  assert.ok(x.documentListeners.has('visibilitychange'));
  x.catalog.treeStatus=statusPacket([resultRow('visible')]);await settle();await x.run('folderMetadataRequest');await settle();assert.equal(x.requests.length,1);assert.equal(x.timeouts.size,1);
  x.document.visibilityState='hidden';x.documentListeners.get('visibilitychange')();await settle();assert.equal(x.timeouts.size,0);
  await advanceMetadataClock(x,clock,120000);assert.equal(x.requests.length,1);
  x.document.visibilityState='visible';x.documentListeners.get('visibilitychange')();await settle();assert.equal(x.requests.length,2);
  x.s.sidebarView.value='recent';await settle();assert.equal(x.timeouts.size,0);
  await advanceMetadataClock(x,clock,60000);assert.equal(x.requests.length,2);
  x.s.sidebarView.value='folders';await settle();assert.equal(x.requests.length,3);
  x.s.query.value='search';await settle();await advanceMetadataClock(x,clock,60000);assert.equal(x.requests.length,3);
  x.s.query.value='';await settle();assert.equal(x.requests.length,4);
  x.catalog.treeStatus=statusPacket([]);await settle();assert.equal(x.timeouts.size,0);
  await advanceMetadataClock(x,clock,60000);assert.equal(x.requests.length,4);
  x.catalog.treeStatus=statusPacket([resultRow('visible')]);await settle();await x.run('folderMetadataRequest');await settle();assert.equal(x.requests.length,5);assert.equal(x.timeouts.size,1);
  x.unmounted.forEach(fn=>fn());assert.equal(x.timeouts.size,0);assert.equal(x.documentListeners.has('visibilitychange'),false);
  await advanceMetadataClock(x,clock,120000);assert.equal(x.requests.length,5);
});

test('background metadata does not start before mount and temporary-only activity needs no folder calibration',async t=>{
  const {x,clock}=calibrationFixture(t);x.run('directoryMetadataMounted.value=false');
  x.catalog.treeStatus=statusPacket([resultRow('not-mounted')]);await settle();assert.equal(x.requests.length,0);assert.equal(x.timeouts.size,0);
  x.run('directoryMetadataMounted.value=true');await settle();assert.equal(x.requests.length,1);
  x.catalog.treeStatus=statusPacket([resultRow('only-temp','failed',{folderId:''})]);await settle();assert.equal(x.timeouts.size,0);
  await advanceMetadataClock(x,clock,120000);assert.equal(x.requests.length,1);
  assert.equal(directoryDots(await x.render(),'__temporary').length,1);
});

test('a long metadata request remains single-flight and does not continue after hiding or unmounting',async t=>{
  const {x,clock}=calibrationFixture(t);let resolve;
  x.api.conversationTreeFolders=()=>{x.requests.push(['folders']);return new Promise(done=>{resolve=done;});};
  x.catalog.treeStatus=statusPacket([resultRow('pending-calibration')]);await settle();
  for(let i=0;i<3;i++){x.catalog.treeStatus={...statusPacket([resultRow('pending-calibration')]),revision:i};await settle();}
  await advanceMetadataClock(x,clock,120000);assert.equal(x.requests.length,1);
  x.document.visibilityState='hidden';x.run('updateDirectoryVisibility()');await settle();
  resolve({items:[{folderId:'F',parentId:''},{folderId:'deep',parentId:'F'}]});await settle();await settle();
  assert.equal(x.requests.length,1);assert.equal(x.timeouts.size,0);
  x.document.visibilityState='visible';x.run('updateDirectoryVisibility()');await settle();assert.equal(x.requests.length,2);
  x.unmounted.forEach(fn=>fn());resolve({items:[{folderId:'F',parentId:''},{folderId:'deep',parentId:'F'}]});await settle();await settle();
  await advanceMetadataClock(x,clock,120000);assert.equal(x.requests.length,2);assert.equal(x.timeouts.size,0);
});

test('a failed metadata read backs off instead of retrying on every status and recovers on the next calibration',async t=>{
  const {x,clock}=calibrationFixture(t);const success=x.api.conversationTreeFolders;let first=true;
  x.api.conversationTreeFolders=async()=>{if(first){first=false;x.requests.push(['folders']);throw Error('temporary metadata failure');}return success();};
  x.catalog.treeStatus=statusPacket([resultRow('retry')]);await settle();await settle();assert.equal(x.requests.length,1);
  for(let i=0;i<3;i++){x.catalog.treeStatus={...statusPacket([resultRow('retry')]),revision:i};await settle();}
  assert.equal(x.requests.length,1);await advanceMetadataClock(x,clock,59999);assert.equal(x.requests.length,1);
  await advanceMetadataClock(x,clock,1);assert.equal(x.requests.length,2);assert.equal(directoryDots(await x.render(),'F').length,1);
});
