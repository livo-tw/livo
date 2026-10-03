import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useFocusTrap } from '@/hooks/useFocusTrap';

afterEach(cleanup);
function Fixture(){const trap=useFocusTrap(true);return <><button>Outside</button><div ref={trap}><button>Only enabled control</button><fieldset disabled><button>Disabled through fieldset</button><input aria-label="Disabled input"/></fieldset><button hidden>Hidden control</button></div></>;}

describe('QA modal focus boundaries',()=>{
  it('wraps Tab around effective enabled controls, excluding disabled fieldset descendants',()=>{
    render(<Fixture/>);
    const button=screen.getByRole('button',{name:'Only enabled control'});
    button.focus();
    const forward=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});
    fireEvent(button,forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(button).toHaveFocus();
    const backward=new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true});
    fireEvent(button,backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(button).toHaveFocus();
  });
});
