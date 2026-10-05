import React from 'react';
import type { Priority } from '@/types';
import i18n from 'i18next';
import { ChevronsUp, ChevronUp, Minus, ArrowDown } from 'lucide-react';

/* ── Status Badge ── */
export const StatusBadge = ({ name, color, size = 'sm' }: { name?: string; color?: string; size?: 'xs' | 'sm' }) => {
  if (!name || !color) return null;
  const cls = size === 'xs'
    ? 'text-[10px] font-medium px-1.5 py-0.5 rounded-full text-white'
    : 'text-[13px] font-medium px-1.5 py-0.5 rounded inline-flex items-center gap-1 w-fit text-white';
  return <span className={cls} style={{ backgroundColor: color }}>{name}</span>;
};

/* ── Project Badge ── */
export const ProjectBadge = ({ name, color, size = 'sm' }: { name?: string; color?: string; size?: 'xs' | 'sm' }) => {
  if (!name || !color) return null;
  const cls = size === 'xs'
    ? 'text-[10px] font-semibold px-1.5 py-0.5 rounded truncate'
    : 'text-[13px] font-semibold truncate px-1.5 py-0.5 rounded';
  return <span className={cls} style={{ color, backgroundColor: color + '18' }}>{name}</span>;
};

/* ── Priority Config ── */
export const priorityConfig: Record<Priority, { icon: React.ReactNode; label: string; className: string; bg: string }> = {
  highest: { icon: <ChevronsUp size={13} strokeWidth={2.5} color="#FF5630" />, label: '最高', className: 'text-[#FF5630]', bg: 'bg-[#FF5630]/10' },
  high: { icon: <ChevronUp size={13} strokeWidth={2.5} color="#FF8B00" />, label: '高', className: 'text-[#FF8B00]', bg: 'bg-[#FF8B00]/10' },
  medium: { icon: <Minus size={13} strokeWidth={2.5} color="#FFAB00" />, label: '中', className: 'text-[#FFAB00]', bg: 'bg-[#FFAB00]/15' },
  low: { icon: <ArrowDown size={13} strokeWidth={2.5} color="#0065FF" />, label: '低', className: 'text-[#0065FF]', bg: 'bg-[#0065FF]/10' },
  lowest: { icon: <ArrowDown size={13} strokeWidth={2.5} color="#6B778C" />, label: '最低', className: 'text-[#6B778C]', bg: 'bg-[#6B778C]/10' },
};

/* ── Priority Badge (icon only for lists) ── */
export const PriorityBadge = ({ priority }: { priority: Priority }) => {
  const pri = priorityConfig[priority];
  return (
    <span title={i18n.t(`priority.${priority}`, { defaultValue: pri.label })} className={`inline-flex items-center justify-center ${pri.className}`}>
      {pri.icon}
    </span>
  );
};

/* ── User Avatar Badge ── */
export const UserBadge = ({ user, placeholder = '—' }: { user?: { name: string; avatar: string; color: string } | null; placeholder?: string }) => {
  if (!user) return <span className="text-muted-foreground/40">—</span>;
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-5 h-5 rounded-full flex items-center justify-center text-[7px] font-bold text-white flex-shrink-0" style={{ backgroundColor: user.color }}>
        {user.avatar}
      </div>
      <span className="text-xs truncate">{user.name}</span>
    </div>
  );
};
