import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const state = vi.hoisted(() => ({ cloud: false }));
const auth = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: { email: 'member@example.com' } } })),
  signInWithPassword: vi.fn(async () => ({ error: null as null })),
  updateUser: vi.fn(async () => ({ error: null as null })),
  signOut: vi.fn(async () => ({ error: null as null })),
  refreshSession: vi.fn(async () => ({ error: null as null })),
}));
vi.mock('@/lib/apiBase', () => ({ get USE_CF_BACKEND() { return state.cloud; } }));
vi.mock('@/lib/demoMode', () => ({ IS_DEMO_PRO: false }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Lib = typeof import('@/lib/passwordChangeRequired');
let lib: Lib;
let changeOwnPassword: typeof import('@/lib/changePassword').changeOwnPassword;
let RequiredPasswordChange: typeof import('@/components/RequiredPasswordChange').default;
beforeAll(async () => {
  // changePassword.ts reads the self-host URL when it loads.
  vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:8000');
  lib = await import('@/lib/passwordChangeRequired');
  ({ changeOwnPassword } = await import('@/lib/changePassword'));
  RequiredPasswordChange = (await import('@/components/RequiredPasswordChange')).default;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); state.cloud = false; });
const session = (meta: Record<string, unknown>) => ({ user: { user_metadata: meta } });

describe('a password an admin set', () => {
  it('is recognised from the login metadata on self-host only', () => {
    expect(lib.passwordChangeRequired(session({ [lib.PASSWORD_CHANGE_FLAG]: true }))).toBe(true);
    expect(lib.passwordChangeRequired(session({ [lib.PASSWORD_CHANGE_FLAG]: false }))).toBe(false);
    expect(lib.passwordChangeRequired(session({}))).toBe(false);
    expect(lib.passwordChangeRequired(null)).toBe(false);
    state.cloud = true;
    expect(lib.passwordChangeRequired(session({ [lib.PASSWORD_CHANGE_FLAG]: true }))).toBe(false);
  });

  it('uses the same key as the Docker member functions', () => {
    const source = readFileSync(path.resolve(__dirname, '../../docker/volumes/functions/manage-member/memberAccounts.ts'), 'utf8');
    expect(source).toContain(`export const PASSWORD_CHANGE_FLAG = '${lib.PASSWORD_CHANGE_FLAG}';`);
  });

  it('is cleared in the same call that sets the new password, and a new password must differ', async () => {
    expect(await changeOwnPassword('ExampleTemp42', 'ExampleTemp42')).toEqual({ error: { message: 'settings.passwordSameAsCurrent', code: 'same_password' } });
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(await changeOwnPassword('ExampleTemp42', 'MyOwnPassword9')).toEqual({ error: null });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'member@example.com', password: 'ExampleTemp42' });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'MyOwnPassword9', data: { [lib.PASSWORD_CHANGE_FLAG]: false } });
  });

  it('keeps the app closed behind a password change, with signing out as the other way out', async () => {
    render(<RequiredPasswordChange />);
    expect(screen.getByText('auth.passwordChangeRequiredTitle')).toBeTruthy();
    const [current, next, confirm] = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    fireEvent.change(current, { target: { value: 'ExampleTemp42' } });
    fireEvent.change(next, { target: { value: 'MyOwnPassword9' } });
    fireEvent.change(confirm, { target: { value: 'MyOwnPassword9' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.passwordChangeButton' }));
    await waitFor(() => expect(auth.refreshSession).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'auth.logout' }));
    expect(auth.signOut).toHaveBeenCalled();
  });

  it('is checked before the app opens, and set by every admin password path', () => {
    const app = readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
    expect(app).toMatch(/if \(!session\) return <Navigate[^\n]*\n[^\n]*\n\s*if \(passwordChangeRequired\(session\)\) return <RequiredPasswordChange \/>;\n\s*return <>\{children\}<\/>;/);
    const fn = readFileSync(path.resolve(__dirname, '../../docker/volumes/functions/manage-member/index.ts'), 'utf8');
    expect(fn).toContain('ownLogin ? { password: newPasswordStr } : adminSetPassword(newPasswordStr)');
    expect(fn).toContain('...(adminKnowsPassword ? adminSetPassword(newPassword) : { password: newPassword })');
    expect(fn).toContain('user_metadata: { full_name: nameStr, ...(adminKnowsPassword ? { [PASSWORD_CHANGE_FLAG]: true } : {}) }');
    expect(fn).toContain('user_metadata: { [PASSWORD_CHANGE_FLAG]: true }');
  });
});
