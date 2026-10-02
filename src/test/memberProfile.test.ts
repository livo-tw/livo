import { describe, expect, it } from 'vitest';
import { decideMembersUpdate, isValidMemberAvatar, isValidMemberColor } from '../../worker/src/memberProfile';
import { clipAvatarText } from '@/lib/avatarText';

const MEMBER = 0, ADMIN = 1, SUPER = 2;

describe('decideMembersUpdate (Cloudflare members write rule)', () => {
  it('lets a member change their own badge and theme, on their own row only', () => {
    expect(decideMembersUpdate(MEMBER, { avatar: 'A', color: '#36B37E' })).toBe('own-row');
    expect(decideMembersUpdate(MEMBER, { theme: 'dark', avatar: '🙂' })).toBe('own-row');
  });

  it('keeps every other column closed to members', () => {
    for (const patch of [{ role: 'super_admin' }, { name: 'Example' }, { email: 'x@example.com' }, { avatar: 'A', role: 'admin' }]) {
      expect(decideMembersUpdate(MEMBER, patch)).toBe('deny');
    }
  });

  it('lets admins reorder anyone but change only their own badge', () => {
    expect(decideMembersUpdate(ADMIN, { sort_order: 3 })).toBe('allow');
    expect(decideMembersUpdate(ADMIN, { color: '#000000' })).toBe('own-row');
    expect(decideMembersUpdate(ADMIN, { role: 'member' })).toBe('deny');
    expect(decideMembersUpdate(ADMIN, { auth_id: 'self' })).toBe('own-row');
    expect(decideMembersUpdate(ADMIN, { job_title: 'PM' })).toBe('deny');
  });

  it('leaves super_admin unrestricted', () => {
    expect(decideMembersUpdate(SUPER, { role: 'admin', name: 'Example' })).toBe('allow');
    expect(decideMembersUpdate(SUPER, { job_title: 'PM' })).toBe('allow');
    expect(decideMembersUpdate(SUPER, { job_title: 'x'.repeat(201) })).toBe('invalid');
  });

  it('rejects malformed avatar or colour values', () => {
    expect(decideMembersUpdate(MEMBER, { avatar: '   ' })).toBe('invalid');
    expect(decideMembersUpdate(MEMBER, { avatar: 'x'.repeat(17) })).toBe('invalid');
    expect(decideMembersUpdate(MEMBER, { color: 'red' })).toBe('invalid');
    expect(decideMembersUpdate(ADMIN, { color: '#12345' })).toBe('invalid');
  });

  it('ignores undefined keys like the SQL builder does', () => {
    expect(decideMembersUpdate(MEMBER, { theme: 'light', role: undefined })).toBe('own-row');
  });
});

describe('avatar validators', () => {
  it('accepts short text and emoji, rejects blanks and long text', () => {
    for (const v of ['A', '王', 'AB', '👩‍💻']) expect(isValidMemberAvatar(v)).toBe(true);
    for (const v of ['', ' ', 'x'.repeat(17), 3, null]) expect(isValidMemberAvatar(v)).toBe(false);
  });
  it('accepts only #RRGGBB colours', () => {
    expect(isValidMemberColor('#0065FF')).toBe(true);
    expect(isValidMemberColor('#0065ff')).toBe(true);
    for (const v of ['#FFF', '0065FF', 'blue', '#0065FG', null]) expect(isValidMemberColor(v)).toBe(false);
  });
});

describe('clipAvatarText', () => {
  it('keeps at most two user-perceived characters', () => {
    expect(clipAvatarText('Alice')).toBe('Al');
    expect(clipAvatarText('王小明')).toBe('王小');
    expect(clipAvatarText('👩‍💻👍x')).toBe('👩‍💻👍');
    expect(clipAvatarText('')).toBe('');
  });
});
