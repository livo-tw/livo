import { useState, useEffect, useMemo } from 'react';
import { useMemberContext } from '@/context/MemberContext';
import { useAuthContext } from '@/context/AuthContext';
import { useTaskContext } from '@/context/TaskContext';
import { useProjectContext } from '@/context/ProjectContext';
import { supabase } from '@/integrations/supabase/client';
import { logActivity } from '@/lib/activityLog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { Pencil, Check, X, Sparkles, MessageCircle, AlertTriangle, Bomb, Star, Megaphone, FolderKanban } from 'lucide-react';
import { toast } from 'sonner';
import RichTextEditor from '@/components/RichTextEditor';
import { fixHtml } from '@/components/task-detail/utils';
import { getDepartment, sortUsersByDept, DEPARTMENTS, type Department } from '@/lib/department';
import { useTranslation } from 'react-i18next';

interface MemberManual {
  id: string;
  member_id: string;
  best_state: string;
  communication: string;
  difficulty: string;
  landmine: string;
  bonus: string;
}

const FIELD_DEFS = [
  { key: 'best_state' as const, labelKey: 'teamIntro.fields.bestState', icon: Sparkles, color: 'text-yellow-500' },
  { key: 'communication' as const, labelKey: 'teamIntro.fields.communication', icon: MessageCircle, color: 'text-blue-500' },
  { key: 'difficulty' as const, labelKey: 'teamIntro.fields.difficulty', icon: AlertTriangle, color: 'text-orange-500' },
  { key: 'landmine' as const, labelKey: 'teamIntro.fields.landmine', icon: Bomb, color: 'text-red-500' },
  { key: 'bonus' as const, labelKey: 'teamIntro.fields.bonus', icon: Star, color: 'text-green-500' },
];

/** Format text: add line breaks before numbered items */
function formatManualText(text: string): string {
  return text
    .replace(/([^\n])\s*((?:\d+[.、．)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*)/g, '$1\n$2')
    .trim();
}

const TeamIntroView = () => {
  const { t, i18n } = useTranslation();
  const { users } = useMemberContext();
  const { currentMemberId, currentMember } = useAuthContext();
  const { allTasks } = useTaskContext();
  const { allProjects } = useProjectContext();
  const [manuals, setManuals] = useState<MemberManual[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<MemberManual>>({});

  // Announcement board state
  const [announcementContent, setAnnouncementContent] = useState('');
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [editingAnnouncement, setEditingAnnouncement] = useState(false);
  const [announcementSaving, setAnnouncementSaving] = useState(false);
  const isAdmin = currentMember?.role === 'admin' || currentMember?.role === 'super_admin';

  const activeUsers = sortUsersByDept(users.filter(u => u.isActive));

  const projectNamesByMember = useMemo(() => {
    const projectNames = new Map(allProjects.map(project => [project.id, project.name.trim()]));
    const namesByMember = new Map<string, Set<string>>();

    // Include completed tasks and archived projects from the full task/project stores.
    for (const task of allTasks) {
      const projectName = projectNames.get(task.projectId);
      if (!task.assigneeId || !projectName) continue;

      const names = namesByMember.get(task.assigneeId) ?? new Set<string>();
      names.add(projectName);
      namesByMember.set(task.assigneeId, names);
    }

    const collator = new Intl.Collator(i18n.language, { numeric: true });
    return new Map(Array.from(namesByMember, ([memberId, names]) => [
      memberId, [...names].sort(collator.compare),
    ]));
  }, [allTasks, allProjects, i18n.language]);

  const deptDotColors: Record<string, string> = {
    Manager: '#EF4444', '产品': '#A855F7', BE: '#3B82F6', FE: '#22C55E', SRE: '#06B6D4', QA: '#F97316', other: '#6B778C',
  };

  const deptLabels: Record<string, string> = {
    Manager: t('teamIntro.departments.manager'), '产品': t('teamIntro.departments.product'), BE: t('teamIntro.departments.backend'), FE: t('teamIntro.departments.frontend'), SRE: t('teamIntro.departments.sre'), QA: t('teamIntro.departments.qa'), other: t('teamIntro.departments.other'),
  };

  const deptGroups = useMemo(() => {
    const groups: { dept: string; label: string; members: typeof activeUsers }[] = [];
    const allDepts = [...DEPARTMENTS, 'other'] as string[];
    for (const dept of allDepts) {
      const members = activeUsers.filter(u => {
        const d = getDepartment(u);
        return dept === 'other' ? d === null : d === dept;
      });
      if (members.length > 0) {
        groups.push({ dept, label: deptLabels[dept] || dept, members });
      }
    }
    return groups;
  }, [activeUsers]);

  useEffect(() => {
    fetchManuals();
    fetchAnnouncement();
  }, []);

  const fetchAnnouncement = async () => {
    const { data } = await supabase.from('team_settings').select('value').eq('key', 'team_announcement').maybeSingle();
    if (data?.value && typeof data.value === 'object' && 'content' in data.value) {
      setAnnouncementContent((data.value as Record<string, string>).content || '');
    }
  };

  const saveAnnouncement = async () => {
    setAnnouncementSaving(true);
    await supabase.from('team_settings').upsert({
      key: 'team_announcement',
      value: { content: announcementDraft } as unknown,
      updated_by: currentMemberId,
      updated_at: new Date().toISOString(),
    } as Record<string, unknown>);
    setAnnouncementContent(announcementDraft);
    setEditingAnnouncement(false);
    setAnnouncementSaving(false);
    toast.success(t('teamIntro.announcementSaved'));
  };

  const fetchManuals = async () => {
    const { data } = await supabase.from('member_manuals').select('*');
    if (data) setManuals(data as unknown as MemberManual[]);
  };

  const startEdit = (manual: MemberManual) => {
    setEditingId(manual.member_id);
    setEditDraft({ ...manual });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft({});
  };

  const saveEdit = async (memberId: string) => {
    const { best_state, communication, difficulty, landmine, bonus } = editDraft;
    const existing = manuals.find(m => m.member_id === memberId);

    if (existing) {
      const { error } = await supabase
        .from('member_manuals')
        .update({ best_state, communication, difficulty, landmine, bonus, updated_at: new Date().toISOString() })
        .eq('member_id', memberId);
      if (error) { toast.error(t('teamIntro.saveFailed')); return; }
    } else {
      const { error } = await supabase
        .from('member_manuals')
        .insert({ member_id: memberId, best_state: best_state || '', communication: communication || '', difficulty: difficulty || '', landmine: landmine || '', bonus: bonus || '' });
      if (error) { toast.error(t('teamIntro.saveFailed')); return; }
    }

    toast.success(t('teamIntro.saved'));
    const memberName = users.find(u => u.id === memberId)?.name || memberId;
    if (currentMemberId) {
      await logActivity(currentMemberId, 'update_team_intro', t('teamIntro.editActivityDetail', { name: memberName }), undefined, undefined, 'member');
    }
    setEditingId(null);
    setEditDraft({});
    fetchManuals();
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="w-full max-w-[1600px] mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">{t('teamIntro.pageTitle')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('teamIntro.pageDesc')}</p>
        </div>

        {/* 團隊公告/公約佈告欄 */}
        <Card className="mb-8 border-border/60">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 text-primary flex-shrink-0">
                  <Megaphone size={16} />
                </div>
                {t('teamIntro.announcementTitle')}
              </h2>
              {isAdmin && !editingAnnouncement && (
                <button
                  onClick={() => { setAnnouncementDraft(announcementContent); setEditingAnnouncement(true); }}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors px-2 py-1 rounded hover:bg-accent"
                >
                  <Pencil size={13} />
                  {t('common.edit')}
                </button>
              )}
              {editingAnnouncement && (
                <div className="flex items-center gap-1">
                  <button onClick={() => setEditingAnnouncement(false)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent transition-colors">
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={saveAnnouncement}
                    disabled={announcementSaving}
                    className="flex items-center gap-1 text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                  >
                    <Check size={13} />
                    {announcementSaving ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              )}
            </div>
            {editingAnnouncement ? (
              <RichTextEditor
                content={announcementDraft}
                onChange={setAnnouncementDraft}
                placeholder={t('teamIntro.announcementPlaceholder')}
                members={users}
              />
            ) : announcementContent ? (
              <div
                className="prose prose-sm max-w-none text-foreground/90"
                dangerouslySetInnerHTML={{ __html: fixHtml(announcementContent) }}
              />
            ) : (
              <p className="text-sm text-muted-foreground/60 italic">
                {isAdmin ? t('teamIntro.announcementAdminEmpty') : t('teamIntro.announcementEmpty')}
              </p>
            )}
          </CardContent>
        </Card>

        {deptGroups.map(({ dept, label, members }) => (
          members.length > 0 && (
            <div key={dept} className="mb-8">
              <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: deptDotColors[dept] }} />
                {label}
                <span className="text-xs text-muted-foreground font-normal">({members.length})</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {members.map(user => {
            const manual = manuals.find(m => m.member_id === user.id);
            const isEditing = editingId === user.id;
            const canEdit = currentMemberId === user.id;
            const projectNames = projectNamesByMember.get(user.id) ?? [];

            return (
              <Card key={user.id} className="min-w-0 overflow-hidden border-border/60 hover:shadow-md transition-shadow">
                {/* Header */}
                <div className="flex items-center gap-3 p-4 pb-2 border-b border-border/40">
                  <Avatar className="h-12 w-12 ring-2 ring-offset-2 ring-offset-background" style={{ '--tw-ring-color': user.color } as React.CSSProperties}>
                    <AvatarImage src={user.avatar} alt={user.name} />
                    <AvatarFallback style={{ backgroundColor: user.color, color: '#fff' }}>
                      {user.name.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-foreground truncate">{user.name}</div>
                    <div className="text-xs text-muted-foreground">{user.jobTitle || t('teamIntro.teamMember')}</div>
                  </div>
                  {canEdit && !isEditing && (
                    <button
                      onClick={() => startEdit(manual || { id: '', member_id: user.id, best_state: '', communication: '', difficulty: '', landmine: '', bonus: '' })}
                      className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                      title={t('teamIntro.editMyManual')}
                    >
                      <Pencil size={15} />
                    </button>
                  )}
                  {isEditing && (
                    <div className="flex gap-1">
                      <button onClick={() => saveEdit(user.id)} className="p-1.5 rounded-md hover:bg-accent text-green-600 transition-colors" title={t('common.save')}>
                        <Check size={15} />
                      </button>
                      <button onClick={cancelEdit} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors" title={t('common.cancel')}>
                        <X size={15} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Content */}
                <CardContent className="p-4 space-y-3">
                  {FIELD_DEFS.map(field => {
                    const Icon = field.icon;
                    const value = isEditing
                      ? (editDraft[field.key] ?? '')
                      : (manual?.[field.key] || '');

                    return (
                      <div key={field.key}>
                        <div className="flex items-center gap-1.5 mb-1">
                          <Icon size={13} className={field.color} />
                          <span className="text-xs font-medium text-muted-foreground">{t(field.labelKey)}</span>
                        </div>
                        {isEditing ? (
                          <textarea
                            value={value}
                            onChange={e => setEditDraft(prev => ({ ...prev, [field.key]: e.target.value }))}
                            className="w-full text-sm bg-muted/50 border border-border rounded-md px-2.5 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary min-h-[56px]"
                            rows={2}
                          />
                        ) : value ? (
                          <div className="text-sm text-foreground/80 leading-relaxed whitespace-pre-line">
                            {formatManualText(value)}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground/50 italic">{t('teamIntro.notFilled')}</p>
                        )}
                      </div>
                    );
                  })}
                  <section aria-label={t('teamIntro.fields.projects')}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <FolderKanban size={13} className="text-violet-500 shrink-0" aria-hidden="true" />
                      <span className="text-xs font-medium text-muted-foreground">{t('teamIntro.fields.projects')}</span>
                    </div>
                    {projectNames.length > 0 ? (
                      <ul className="list-disc pl-5 space-y-1 text-sm text-foreground/80 leading-relaxed marker:text-muted-foreground/60">
                        {projectNames.map(name => (
                          <li key={name} className="[overflow-wrap:anywhere]">{name}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground/50 italic">{t('teamIntro.noProjects')}</p>
                    )}
                  </section>
                </CardContent>
              </Card>
            );
          })}
              </div>
            </div>
          )
        ))}
      </div>
    </div>
  );
};

export default TeamIntroView;
