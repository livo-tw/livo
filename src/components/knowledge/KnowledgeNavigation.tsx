import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type CollisionDetection, type KeyboardCoordinateGetter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, GripVertical, Pin, Star, MoreHorizontal, ArrowUp, ArrowDown } from 'lucide-react';
import { buildKnowledgeTree, searchKnowledge, knowledgeSnippet, type KnowledgeNode } from '@/lib/knowledge';
import { navigationScope, orderedNavigation, type NavigationCommand } from '../../../worker/src/knowledgePreferenceModel';
import type { KnowledgePage } from '@/types/knowledge';
import type { useKnowledgeNavigation } from '@/hooks/useKnowledgeNavigation';

type Navigation = ReturnType<typeof useKnowledgeNavigation>;
type Props = { pages: KnowledgePage[]; groups: {id:string;name:string}[]; query: string; filtered: boolean; selectedId: string | null; onSelect: (id:string) => void; navigation: Navigation; busy?: boolean; scopeName: (id:string|null)=>string };
const key = (name: string) => `kb.navigation.${name}`;

export function KnowledgePageActions({ page, navigation, busy }: {page:KnowledgePage;navigation:Navigation;busy?:boolean}) {
  const { t } = useTranslation();
  const item = navigation.preferences.items[page.id];
  const invoke = (command: NavigationCommand): void => { void navigation.mutate(command); };
  return <div className="flex shrink-0 items-center">
    <button type="button" disabled={busy || navigation.saving} aria-pressed={!!item?.favorite} aria-label={t(key(item?.favorite ? 'unfavorite' : 'favorite'), { title: page.title, defaultValue: `${item?.favorite ? 'Remove favorite' : 'Favorite'}: ${page.title}` })}
      className="p-2 rounded hover:bg-muted focus-visible:ring-2" onClick={() => {
        if (item?.pinned && !window.confirm(t(key('removePinnedFavorite'), { defaultValue: 'Remove this favorite and its personal pin?' }))) return;
        invoke({ p_action:'favorite',p_page_id:page.id,p_value:!item?.favorite });
      }}><Star size={15} className={item?.favorite ? 'fill-amber-400 text-amber-600' : 'text-muted-foreground'} /></button>
    <button type="button" disabled={busy || navigation.saving} aria-pressed={!!item?.pinned} aria-label={t(key(item?.pinned ? 'unpin' : 'pin'), { title: page.title, defaultValue: `${item?.pinned ? 'Unpin' : 'Pin for me'}: ${page.title}` })}
      className="p-2 rounded hover:bg-muted focus-visible:ring-2" onClick={() => invoke({p_action:'pin',p_page_id:page.id,p_value:!item?.pinned})}><Pin size={15} className={item?.pinned ? 'fill-primary/20 text-primary' : 'text-muted-foreground'} /></button>
  </div>;
}

type RowProps = { node:KnowledgeNode; depth:number; selectedId:string|null; collapsed:boolean; reorder:boolean; disabled:boolean; onSelect:(id:string)=>void; onToggle:()=>void; onMove:(direction:-1|1)=>void; onReset:()=>void; first:boolean; last:boolean; navigation:Navigation; children?:React.ReactNode };
function NavigationRow({node,depth,selectedId,collapsed,reorder,disabled,onSelect,onToggle,onMove,onReset,first,last,navigation,children}:RowProps) {
  const { t } = useTranslation();
  const sortable = useSortable({id:node.id,disabled:!reorder || disabled});
  return <li style={{transform:CSS.Transform.toString(sortable.transform),transition:sortable.transition}} className={sortable.isDragging ? 'relative z-20' : ''}>
    <div ref={sortable.setNodeRef} data-kb-row={node.id} className={`flex items-center rounded-lg my-0.5 ${sortable.isDragging ? 'bg-card shadow-lg ring-2 ring-primary' : ''} ${node.id===selectedId ? 'bg-primary/15 text-primary font-semibold' : 'hover:bg-muted'}`} style={{paddingLeft:`${depth*12}px`}}>
      {reorder && <button type="button" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners} disabled={disabled} aria-label={t(key('drag'),{title:node.title,defaultValue:`Move in my order: ${node.title}`})} className="p-2 touch-none"><GripVertical size={14}/></button>}
      {node.children.length ? <button type="button" disabled={disabled} onClick={onToggle} aria-expanded={!collapsed} aria-label={t(key(collapsed?'expand':'collapse'),{title:node.title,defaultValue:`${collapsed?'Expand':'Collapse'}: ${node.title}`})} className="min-h-11 min-w-11 flex items-center justify-center">{collapsed?<ChevronRight size={15}/>:<ChevronDown size={15}/>}</button>:<span className="w-5 shrink-0"/>}
      <button type="button" data-kb-page={node.id} disabled={disabled} onClick={()=>onSelect(node.id)} onKeyDown={event=>{
        if(event.key==='ArrowRight'&&node.children.length&&collapsed){event.preventDefault();onToggle();}
        else if(event.key==='ArrowLeft'&&node.children.length&&!collapsed){event.preventDefault();onToggle();}
        else if(event.key==='ArrowUp'||event.key==='ArrowDown'){
          event.preventDefault();const buttons=Array.from(event.currentTarget.closest('nav')?.querySelectorAll<HTMLButtonElement>('button[data-kb-page]')||[]);
          const index=buttons.indexOf(event.currentTarget);buttons[index+(event.key==='ArrowUp'?-1:1)]?.focus();
        }
      }} aria-current={node.id===selectedId?'page':undefined} className="text-left flex-1 min-w-0 py-3 text-sm"><span className="block truncate">{node.title}</span>{node.is_archived&&<span className="text-xs text-muted-foreground">{t('kb.archived')}</span>}</button>
      {!reorder && <KnowledgePageActions page={node} navigation={navigation} busy={disabled}/>}
      {reorder && <details className="relative shrink-0"><summary aria-label={t(key('moveMenu'),{title:node.title,defaultValue:`Move options: ${node.title}`})} className="list-none p-2 cursor-pointer"><MoreHorizontal size={16}/></summary>
        <div className="absolute right-0 z-30 border rounded bg-popover shadow p-1 min-w-40 text-xs">
          <button type="button" className="flex gap-2 p-2 w-full" disabled={disabled||first} onClick={()=>onMove(-1)}><ArrowUp size={14}/>{t(key('moveUp'),{defaultValue:'Move up'})}</button>
          <button type="button" className="flex gap-2 p-2 w-full" disabled={disabled||last} onClick={()=>onMove(1)}><ArrowDown size={14}/>{t(key('moveDown'),{defaultValue:'Move down'})}</button>
          <button type="button" className="p-2 w-full text-left" disabled={disabled} onClick={onReset}>{t(key('resetOrder'),{defaultValue:'Restore team order'})}</button>
        </div>
      </details>}
    </div>
    {!collapsed&&children}
  </li>;
}

export default function KnowledgeNavigation({pages,groups,query,filtered,selectedId,onSelect,navigation,busy=false,scopeName}:Props) {
  const { t } = useTranslation();
  const [view,setView]=useState<'tree'|'favorites'|'pins'>('tree');
  const [editingOrder,setEditingOrder]=useState(false);
  const [temporary,setTemporary]=useState<Record<string,boolean>>({});
  const [revealed,setRevealed]=useState<Set<string>>(new Set());
  const [message,setMessage]=useState('');
  const {preferences}=navigation;
  const allowedDropIds=(activeId:string)=>{
    const activePage=pages.find(page=>page.id===activeId);
    if(!activePage)return new Set<string>();
    return new Set(pages.filter(page=>view==='pins'?preferences.items[page.id]?.pinned:navigationScope(page)===navigationScope(activePage)).map(page=>page.id));
  };
  const siblingCollisions:CollisionDetection=args=>{
    const allowed=allowedDropIds(String(args.active.id));
    return closestCenter({...args,droppableContainers:args.droppableContainers.filter(item=>allowed.has(String(item.id)))});
  };
  const siblingKeyboardCoordinates:KeyboardCoordinateGetter=(event,args)=>{
    const allowed=allowedDropIds(String(args.active));
    // The standard getter inspects every registered container. Removing other
    // scopes' rectangles stops an expanded parent from intercepting ArrowUp.
    return sortableKeyboardCoordinates(event,{...args,context:{...args.context,droppableRects:new Map([...args.context.droppableRects].filter(([id])=>allowed.has(String(id))))}});
  };
  const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:8}}),useSensor(KeyboardSensor,{coordinateGetter:siblingKeyboardCoordinates}));
  useEffect(()=>{setTemporary({});setEditingOrder(false);},[query,filtered]);
  const reorder=editingOrder&&!filtered&&!query.trim()&&view!=='favorites';
  const disabled=busy||navigation.saving;
  const scopeIds=new Set(groups.map(g=>g.id));
  const scoped=pages.filter(p=>scopeIds.has(p.project_id||'shared'));
  const pinPages=orderedNavigation(scoped.filter(p=>preferences.items[p.id]?.pinned),preferences.pins) as KnowledgePage[];
  const results=useMemo(()=>searchKnowledge(pages,query),[pages,query]).filter(p=>view==='tree'||preferences.items[p.id]?.[view==='pins'?'pinned':'favorite']);
  const selectedAncestors=new Set<string>();
  let cursor=pages.find(p=>p.id===selectedId);
  while(cursor?.parent_id&&!selectedAncestors.has(cursor.parent_id)){selectedAncestors.add(cursor.parent_id);cursor=pages.find(p=>p.id===cursor!.parent_id);}
  const revealKey=JSON.stringify([selectedId,...selectedAncestors]);
  useEffect(()=>{setRevealed(new Set(selectedAncestors));},[revealKey]);
  const collapsed=(node:KnowledgeNode)=>temporary[node.id]??(filtered || revealed.has(node.id) ? false : preferences.items[node.id]?.collapsed??true);
  const toggle=(node:KnowledgeNode)=>{
    if(filtered||query.trim())setTemporary(old=>({...old,[node.id]:!collapsed(node)}));
    else void navigation.mutate({p_action:'collapse',p_page_id:node.id,p_value:!collapsed(node)}).then(ok=>{if(ok)setRevealed(old=>{const next=new Set(old);next.delete(node.id);return next;});});
  };
  async function move(page:KnowledgePage,before:string|null,kind:'tree'|'pins'){
    const ok=await navigation.mutate({p_action:'reorder',p_page_id:page.id,p_before_id:before,p_order_kind:kind});
    setMessage(t(key(ok?'orderSaved':'orderFailed'),{defaultValue:ok?'My order saved.':'Order was not saved. Please retry.'}));
  }
  const siblingsFor=(page:KnowledgePage)=>view==='pins'?pinPages:orderedNavigation(pages.filter(p=>navigationScope(p)===navigationScope(page)),preferences.orders[navigationScope(page)]) as KnowledgePage[];
  const moveRelative=(page:KnowledgePage,direction:-1|1)=>{
    const list=siblingsFor(page),index=list.findIndex(p=>p.id===page.id),to=index+direction;
    if(to<0||to>=list.length)return;
    const next=arrayMove(list,index,to);void move(page,next[to+1]?.id||null,view==='pins'?'pins':'tree');
  };
  const onDragEnd=({active,over}:DragEndEvent)=>{
    if(!reorder||!over||active.id===over.id)return;
    const page=pages.find(p=>p.id===active.id),target=pages.find(p=>p.id===over.id);
    if(!page||!target||(view!=='pins'&&navigationScope(page)!==navigationScope(target))) {setMessage(t(key('sameParent'),{defaultValue:'Move pages only within the same parent.'}));return;}
    const list=siblingsFor(page),from=list.findIndex(p=>p.id===page.id),to=list.findIndex(p=>p.id===target.id);
    if(from<0||to<0)return;
    const next=arrayMove(list,from,to);void move(page,next[to+1]?.id||null,view==='pins'?'pins':'tree');
  };
  const renderNodes=(nodes:KnowledgeNode[],depth=0):React.ReactNode=>{
    const list=orderedNavigation(nodes,preferences.orders[nodes[0]?navigationScope(nodes[0]):'']) as KnowledgeNode[];
    return <SortableContext items={list.map(p=>p.id)} strategy={verticalListSortingStrategy}><ul>{list.map((node,index)=><NavigationRow key={node.id} node={node} depth={depth} selectedId={selectedId} collapsed={collapsed(node)} reorder={reorder} disabled={disabled} onSelect={onSelect} onToggle={()=>toggle(node)} onMove={direction=>moveRelative(node,direction)} onReset={()=>void navigation.mutate({p_action:'reset',p_page_id:node.id,p_order_kind:view==='pins'?'pins':'tree'})} first={index===0} last={index===list.length-1} navigation={navigation}>{node.children.length>0&&renderNodes(node.children,depth+1)}</NavigationRow>)}</ul></SortableContext>;
  };
  const flat=(list:KnowledgePage[],drag=false)=>drag?<SortableContext items={list.map(p=>p.id)} strategy={verticalListSortingStrategy}><ul>{list.map((page,index)=><NavigationRow key={page.id} node={{...page,children:[]}} depth={0} selectedId={selectedId} collapsed reorder={reorder} disabled={disabled} onSelect={onSelect} onToggle={()=>{}} onMove={direction=>moveRelative(page,direction)} onReset={()=>void navigation.mutate({p_action:'reset',p_page_id:page.id,p_order_kind:'pins'})} first={index===0} last={index===list.length-1} navigation={navigation}/>)}</ul></SortableContext>:<ul>{list.map(page=><li key={page.id} className="flex items-center rounded-lg hover:bg-muted"><button type="button" disabled={disabled} onClick={()=>onSelect(page.id)} className="p-3 text-left min-w-0 flex-1" aria-current={page.id===selectedId?'page':undefined}><span className="block text-sm font-semibold truncate">{page.title}</span><span className="text-xs text-muted-foreground">{scopeName(page.project_id)}</span>{query.trim()&&<span className="block text-xs break-words">{knowledgeSnippet(page.body,query)}</span>}</button><KnowledgePageActions page={page} navigation={navigation} busy={disabled}/></li>)}</ul>;
  async function toggleAll(value:boolean){
    const parents=scoped.filter(p=>pages.some(child=>child.parent_id===p.id));
    if(filtered||query.trim()){setTemporary(Object.fromEntries(parents.map(p=>[p.id,value])));return;}
    for(const page of parents){
      if(!await navigation.mutate({p_action:'collapse',p_page_id:page.id,p_value:value}))break;
      setRevealed(old=>{const next=new Set(old);next.delete(page.id);return next;});
    }
  }
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-1 text-xs" role="group" aria-label={t(key('views'),{defaultValue:'Personal navigation'})}>{(['tree','favorites','pins'] as const).map(value=><button type="button" key={value} aria-pressed={view===value} className={`px-2 py-2 rounded ${view===value?'bg-primary/15 text-primary':'hover:bg-muted'}`} onClick={()=>{setView(value);setEditingOrder(false);}}>{t(key(value),{defaultValue:{tree:'All pages',favorites:'My favorites',pins:'My pins'}[value]})}</button>)}</div>
    {navigation.error&&<p role="alert" className="text-xs text-destructive p-2">{t(key('saveError'),{defaultValue:'Navigation could not be saved or loaded.'})} <button type="button" className="underline" onClick={()=>void navigation.refresh()}>{t('kb.retry')}</button></p>}
    {navigation.status==='local'&&<p role="status" className="text-xs px-2 text-muted-foreground">{t(key('localOnly'),{defaultValue:'Saved on this device; reconnect to sync.'})}</p>}
    {navigation.status==='memory'&&<p role="status" className="text-xs px-2 text-muted-foreground">{t(key('memoryOnly'),{defaultValue:'Available in this session only.'})}</p>}
    <div className="flex flex-wrap gap-2 px-2 text-xs">
      {view==='tree'&&<><button type="button" disabled={disabled} onClick={()=>void toggleAll(false)}>{t(key('expandAll'),{defaultValue:'Expand all'})}</button><button type="button" disabled={disabled} onClick={()=>void toggleAll(true)}>{t(key('collapseAll'),{defaultValue:'Collapse all'})}</button></>}
      {view!=='favorites'&&<button type="button" disabled={filtered||!!query.trim()||disabled} title={filtered?t(key('clearFilters'),{defaultValue:'Clear filters to reorder.'}):undefined} aria-pressed={editingOrder} onClick={()=>setEditingOrder(!editingOrder)}>{t(key(editingOrder?'finishOrder':'editOrder'),{defaultValue:editingOrder?'Done ordering':'Adjust my order'})}</button>}
    </div>
    <p role="status" aria-live="polite" className="text-xs px-2 text-muted-foreground">{message}</p>
    <DndContext sensors={sensors} collisionDetection={siblingCollisions} onDragEnd={onDragEnd}>
      {query.trim()?<><p className="px-3 text-xs text-muted-foreground">{t('kb.searchAll')}</p>{!results.length?<p className="p-3 text-sm text-muted-foreground">{t('kb.noResults')}</p>:flat(results)}</>:view==='favorites'?<>{flat(scoped.filter(p=>preferences.items[p.id]?.favorite))}{!scoped.some(p=>preferences.items[p.id]?.favorite)&&<p className="p-3 text-sm text-muted-foreground">{t(key('emptyFavorites'),{defaultValue:'No favorites in this scope.'})}</p>}</>:null}
      {!query.trim()&&view==='pins'&&flat(pinPages,true)}
      {!query.trim()&&view==='tree'&&<>
        {!!pinPages.length&&<section className="mb-4 border-b pb-3"><h2 className="px-3 py-2 text-xs font-bold">{t(key('pins'),{defaultValue:'My pins'})}</h2>{flat(pinPages.slice(0,8))}{pinPages.length>8&&<button type="button" className="px-3 text-xs underline" onClick={()=>setView('pins')}>{t(key('showAll'),{defaultValue:'Show all'})}</button>}</section>}
        {groups.map(group=><section key={group.id} className="mb-4"><h2 className="px-3 py-2 text-xs font-bold text-muted-foreground">{group.name}</h2>{renderNodes(buildKnowledgeTree(scoped.filter(p=>(p.project_id||'shared')===group.id)))}{!scoped.some(p=>(p.project_id||'shared')===group.id)&&<p className="px-3 text-xs text-muted-foreground">{t('kb.emptyGroup')}</p>}</section>)}
      </>}
    </DndContext>
  </div>;
}
