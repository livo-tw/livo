import { createRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
const rows=Array.from({length:6},(_,i)=>({value:`choice-${i+1}`,label:`Choice ${i+1}`}));
const Options=({count=6}:{count?:number})=><>{rows.slice(0,count).map(row=><option key={row.value} value={row.value}>{row.label}</option>)}</>;
const open=()=>fireEvent.click(screen.getByRole('combobox',{name:'Select example'}));
const input=()=>screen.getByRole('combobox',{name:'common.search · Select example'});
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){} unobserve(){} disconnect(){}});
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
});
afterEach(()=>{cleanup();Reflect.deleteProperty(HTMLElement.prototype,'scrollIntoView');vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('shared SearchableSelect native and searchable contracts',()=>{
  it('preserves native multiple selection and its FormData entries',()=>{
    render(<form aria-label="Example form"><SearchableSelect multiple name="choice" aria-label="Select example" defaultValue={['choice-1','choice-3']}><Options/></SearchableSelect></form>);
    expect(screen.getByRole('listbox',{name:'Select example'}).tagName).toBe('SELECT');
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).getAll('choice')).toEqual(['choice-1','choice-3']);
  });
  it('keeps five choices native and uses search for more than five existing options',()=>{
    const {rerender}=render(<SearchableSelect aria-label="Select example"><option value="">Choose</option><Options count={5}/></SearchableSelect>);
    expect(screen.getByRole('combobox',{name:'Select example'}).tagName).toBe('SELECT');
    rerender(<SearchableSelect aria-label="Select example"><option value="">Choose</option><Options/></SearchableSelect>);
    expect(screen.getByRole('combobox',{name:'Select example'}).tagName).toBe('BUTTON');
    open();fireEvent.change(input(),{target:{value:'not an existing choice'}});
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('common.noResults');
    fireEvent.keyDown(input(),{key:'Enter'});
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('');
  });
  it('filters labels and dispatches the native select value while keeping FormData/ref valid',()=>{
    const ref=createRef<HTMLSelectElement>(),changed=vi.fn();
    render(<form aria-label="Example form"><SearchableSelect ref={ref} name="choice" aria-label="Select example" defaultValue="choice-1" onChange={event=>changed(event.target.value)}><Options/></SearchableSelect></form>);
    open();fireEvent.change(input(),{target:{value:'Choice 4'}});
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option',{name:'Choice 4'}));
    expect(changed).toHaveBeenCalledWith('choice-4');
    expect(ref.current?.value).toBe('choice-4');
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('choice')).toBe('choice-4');
    expect(screen.getByRole('combobox',{name:'Select example'})).toHaveTextContent('Choice 4');
  });
  it('keeps controlled values authoritative when parent accepts or rejects a change',()=>{
    const changes=vi.fn();
    const {rerender}=render(<SearchableSelect aria-label="Select example" value="choice-2" onChange={event=>changes(event.target.value)}><Options/></SearchableSelect>);
    open();fireEvent.click(screen.getByRole('option',{name:'Choice 5'}));
    expect(changes).toHaveBeenCalledWith('choice-5');
    expect(screen.getByRole('combobox',{name:'Select example'})).toHaveTextContent('Choice 2');
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('choice-2');
    rerender(<SearchableSelect aria-label="Select example" value="choice-5" onChange={()=>{}}><Options/></SearchableSelect>);
    expect(screen.getByRole('combobox',{name:'Select example'})).toHaveTextContent('Choice 5');
  });
  it('preserves required native validation and focuses the visible trigger',()=>{
    const ref=createRef<HTMLSelectElement>();
    render(<form aria-label="Example form"><label htmlFor="example">Select example</label><SearchableSelect id="example" ref={ref} required name="choice" defaultValue=""><option value="">Choose</option><Options/></SearchableSelect></form>);
    const form=screen.getByRole('form') as HTMLFormElement;
    let valid = true;
    act(()=>{valid=form.checkValidity();});
    expect(valid).toBe(false);
    expect(screen.getByRole('combobox',{name:'Select example'})).toHaveFocus();
    expect(ref.current?.validity.valueMissing).toBe(true);
    open();fireEvent.click(screen.getByRole('option',{name:'Choice 3'}));
    expect(form.checkValidity()).toBe(true);
  });
  it('reads nested ProjectSelectOptions and lets search match the product-line group',()=>{
    const groups=[{line:{id:'line-a',name:'Platform'},projects:rows.map(row=>({id:row.value,name:row.label,lineId:'line-a'}))}];
    render(<SearchableSelect aria-label="Select example"><ProjectSelectOptions groups={groups}/></SearchableSelect>);
    open();fireEvent.change(input(),{target:{value:'Platform'}});
    expect(screen.getAllByRole('option')).toHaveLength(6);
    expect(screen.getByText('Platform')).toBeVisible();
    fireEvent.click(screen.getByRole('option',{name:'Choice 6'}));
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('choice-6');
  });
  it('does not select disabled rows/groups and closes when the entire picker becomes disabled',()=>{
    const children=<><option value="enabled">Enabled</option><optgroup label="Disabled" disabled><option value="no">Unavailable</option></optgroup><Options count={5}/></>;
    const changed=vi.fn(),{rerender}=render(<SearchableSelect aria-label="Select example" onChange={changed}>{children}</SearchableSelect>);
    open();fireEvent.click(screen.getByRole('option',{name:'Unavailable'}));
    expect(changed).not.toHaveBeenCalled();
    rerender(<SearchableSelect aria-label="Select example" disabled onChange={changed}>{children}</SearchableSelect>);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox',{name:'Select example'})).toBeDisabled();
  });
  it('supports keyboard selection and Escape closes only its popover inside a dialog',async()=>{
    const onOpenChange=vi.fn(),submit=vi.fn();
    render(<Dialog open onOpenChange={onOpenChange}><DialogContent aria-describedby={undefined}><DialogTitle>Parent dialog</DialogTitle><form onSubmit={submit}><SearchableSelect aria-label="Select example"><Options/></SearchableSelect></form></DialogContent></Dialog>);
    fireEvent.keyDown(screen.getByRole('combobox',{name:'Select example'}),{key:'ArrowDown'});
    const search=input();fireEvent.change(search,{target:{value:'Choice 4'}});
    await waitFor(()=>expect(screen.getByRole('option',{name:'Choice 4'})).toHaveAttribute('aria-selected','true'));
    fireEvent.keyDown(search,{key:'Enter'});
    expect(screen.getByRole('combobox',{name:'Select example'})).toHaveTextContent('Choice 4');
    open();fireEvent.keyDown(input(),{key:'Escape'});
    await waitFor(()=>expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
  });
  it('refreshes labels/value availability and returns to native mode as options change',()=>{
    const {rerender}=render(<SearchableSelect aria-label="Select example" defaultValue="choice-6"><Options/></SearchableSelect>);
    expect(screen.getByRole('combobox',{name:'Select example'})).toHaveTextContent('Choice 6');
    rerender(<SearchableSelect aria-label="Select example" defaultValue="choice-6"><option value="choice-1">Renamed</option><Options count={4}/></SearchableSelect>);
    expect(screen.getByRole('combobox',{name:'Select example'}).tagName).toBe('SELECT');
    expect((screen.getByRole('combobox',{name:'Select example'}) as HTMLSelectElement).value).toBe('choice-1');
  });
  it('restores the visible uncontrolled selection when its owning form resets',async()=>{
    render(<form aria-label="Example form"><SearchableSelect aria-label="Select example" defaultValue="choice-1"><Options/></SearchableSelect></form>);
    open();fireEvent.click(screen.getByRole('option',{name:'Choice 4'}));
    act(()=>{(screen.getByRole('form') as HTMLFormElement).reset();});
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('choice-1');
    await waitFor(()=>expect(screen.getByRole('combobox',{name:'Select example'})).toHaveTextContent('Choice 1'));
  });
  it('sees options updated by a nested component without requiring its parent to rerender',async()=>{
    let changeLabel: (label:string)=>void = ()=>{};
    const DynamicOptions=()=>{const [label,setLabel]=useState('Original');changeLabel=setLabel;return <><option value="dynamic">{label}</option><Options/></>;};
    render(<SearchableSelect aria-label="Select example" defaultValue="dynamic"><DynamicOptions/></SearchableSelect>);
    act(()=>changeLabel('Renamed'));
    expect((document.querySelector('select') as HTMLSelectElement).selectedOptions[0].label).toBe('Renamed');
    await waitFor(()=>expect(screen.getByRole('combobox',{name:'Select example'})).toHaveTextContent('Renamed'));
  });
});
