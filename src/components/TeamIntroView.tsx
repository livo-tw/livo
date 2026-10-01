import { useState, useEffect, useMemo } from 'react';
import { useMemberContext } from '@/context/MemberContext';
import { useAuthContext } from '@/context/AuthContext';
import { useTaskContext } from '@/context/TaskContext';
import { useProjectContext } from '@/context/ProjectContext';
import { supabase } from '@/integrations/supabase/client';
import { logActivity } from '@/lib/activityLog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { Pencil, Check, X, Sparkles, MessageCircle, AlertTriangle, Bomb, Star, Megaphone, FolderKanban, FileText, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import RichTextEditor from '@/components/RichTextEditor';
import { fixHtml } from '@/components/task-detail/utils';
import { getDepartment, sortUsersByDept, type Department } from '@/lib/department';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import TeamIntroTemplateEditor from '@/components/TeamIntroTemplateEditor';
import { useTeamIntroTemplate } from '@/hooks/useTeamIntroTemplate';
import { isManualTextKey, teamIntroFieldLabel, type TeamIntroTemplate } from '@/lib/teamIntroTemplate';

interface MemberManual {
  id: string;
  member_id: string;
  best_state: string;
  communication: string;
  difficulty: string;
  landmine: string;
  bonus: string;
  custom_fields?: Record<string, string>;
}

const FIELD_STYLES: Record<string, { icon: typeof Sparkles; color: string }> = {
  best_state: { icon: Sparkles, color: 'text-yellow-500' },
  communication: { icon: MessageCircle, color: 'text-blue-500' },
  difficulty: { icon: AlertTriangle, color: 'text-orange-500' },
  landmine: { icon: Bomb, color: 'text-red-500' },
  bonus: { icon: Star, color: 'text-green-500' },
  projects: { icon: FolderKanban, color: 'text-violet-500' },
};

/** Format text: add line breaks before numbered items */
function formatManualText(text: string): string {
  return text
    .replace(/([^\n])\s*((?:\d+[.、．)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*)/g, '$1\n$2')
    .trim();
}

const TeamIntroView = () => {
  const { t } = useTranslation();
  const { users } = useMemberContext();
  const { currentMemberId, currentMember } = useAuthContext();
  const { allTasks } = useTaskContext();
  const { allProjects, productLines } = useProjectContext();
  const [manuals, setManuals] = useState<MemberManual[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<MemberManual>>({});
  const [manualSaving, setManualSaving] = useState(false);
  const templateState = useTeamIntroTemplate();
  const [templateEditor, setTemplateEditor] = useState<{ template: TeamIntroTemplate; revision: string | null } | null>(null);
  const canManageTemplate = currentMember?.role === 'super_admin';

  // Announcement board state
  const [announcementContent, setAnnouncementContent] = useState('');
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [editingAnnouncement, setEditingAnnouncement] = useState(false);
  const [announcementSaving, setAnnouncementSaving] = useState(false);
  const isAdmin = currentMember?.role === 'admin' || currentMember?.role === 'super_admin';

  const activeUsers = useMemo(() => sortUsersByDept(users.filter(u => u.isActive)), [users]);

  const projectNamesByMember = useMemo(() => {
    // Match the sidebar's line/project order, retaining archived project history.
    const orderedProjects = groupProjectsByLine(
      productLines, allProjects, allProjects.filter(project => project.isArchived).map(project => project.id),
    ).flatMap(group => group.projects);
    const projectsByMember = new Map<string, Set<string>>();
    for (const task of allTasks) {
      if (!task.assigneeId) continue;
      const projectIds = projectsByMember.get(task.assigneeId) ?? new Set<string>();
      projectIds.add(task.projectId);
      projectsByMember.set(task.assigneeId, projectIds);
    }

    return new Map(Array.from(projectsByMember, ([memberId, projectIds]) => [
      memberId, [...new Set(orderedProjects
        .filter(project => projectIds.has(project.id))
        .map(project => project.name.trim())
        .filter(Boolean))],
    ]));
  }, [allTasks, allProjects, productLines]);

  const deptDotColors: Record<string, string> = {
    MGR: '#EF4444', PM: '#A855F7', BE: '#3B82F6', FE: '#22C55E', SRE: '#06B6D4', QA: '#F97316', other: '#6B778C',
  };

  const deptLabels: Record<string, string> = {
    MGR: t('teamIntro.departments.manager'), PM: t('teamIntro.departments.product'), BE: t('teamIntro.departments.backend'), FE: t('teamIntro.departments.frontend'), SRE: t('teamIntro.departments.sre'), QA: t('teamIntro.departments.qa'), other: t('teamIntro.departments.other'),
  };

  const deptGroups = useMemo(() => {
    const groups = new Map<Department | 'other', typeof activeUsers>();
    // A department appears where its first member occurs in the managed order.
    for (const user of activeUsers) {
      const dept = getDepartment(user) ?? (user.jobTitle.includes('老大') ? 'MGR' : 'other');
      const members = groups.get(dept) ?? [];
      members.push(user);
      groups.set(dept, members);
    }
    return Array.from(groups, ([dept, members]) => ({ dept, members }));
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
      value: { content: announcementDraft },
      updated_by: currentMemberId,
      updated_at: new Date().toISOString(),
    });
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
    setEditDraft({ ...manual, custom_fields: { ...manual.custom_fields } });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft({});
  };

  const saveEdit = async (memberId: string) => {
    if (manualSaving || !templateState.ready || memberId !== currentMemberId) return;
    const { best_state = '', communication = '', difficulty = '', landmine = '', bonus = '', custom_fields = {} } = editDraft;
    const existing = manuals.find(m => m.member_id === memberId);
    const values = { best_state, communication, difficulty, landmine, bonus, custom_fields, updated_at: new Date().toISOString() };
    setManualSaving(true);
    try {
      const result = existing
        ? await supabase.from('member_manuals').update(values).eq('member_id', memberId).select('id').maybeSingle()
        : await supabase.from('member_manuals').insert({ member_id: memberId, ...values }).select('id').single();
      if (result.error || !result.data) throw result.error ?? new Error('Manual was not saved');
      toast.success(t('teamIntro.saved'));
      const memberName = users.find(u => u.id === memberId)?.name || memberId;
      if (currentMemberId) {
        await logActivity(currentMemberId, 'update_team_intro', t('teamIntro.editActivityDetail', { name: memberName }), undefined, undefined, 'member');
      }
      setEditingId(null);
      setEditDraft({});
      await fetchManuals();
    } catch { toast.error(t('teamIntro.saveFailed')); }
    finally { setManualSaving(false); }
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="w-full max-w-[1600px] mx-auto">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('teamIntro.pageTitle')}</h1>
            <p className="text-sm text-muted-foreground mt-1">{t('teamIntro.pageDesc')}</p>
          </div>
          {canManageTemplate && (
            <Button variant="outline" size="sm" disabled={!templateState.ready}
              onClick={() => setTemplateEditor({ template: templateState.template, revision: templateState.revision })}>
              <Settings2 size={15} className="mr-1.5" />{t('teamIntro.template.edit')}
            </Button>
          )}
        </div>
        {templateState.loadError && (
          <div role="alert" className="mb-4 flex items-center gap-3 text-sm text-destructive">
            {t('teamIntro.template.loadFailed')}
            <Button variant="outline" size="sm" onClick={() => { void templateState.reload(); }}>{t('teamIntro.template.retry')}</Button>
          </div>
        )}
        {templateEditor && canManageTemplate && (
          <TeamIntroTemplateEditor initialTemplate={templateEditor.template} onClose={() => setTemplateEditor(null)}
            onSave={async next => {
              if (!currentMemberId || !canManageTemplate) throw new Error('Permission denied');
              await templateState.save(next, templateEditor.revision, currentMemberId);
            }} />
        )}

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

        {deptGroups.map(({ dept, members }) => (
          members.length > 0 && (
            <div key={dept} className="mb-8">
              <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: deptDotColors[dept] }} />
                {deptLabels[dept] || dept}
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
                    <AvatarFallback style={{ backgroundColor: user.color, color: '#fff' }}>
                      {user.avatar || user.name.charAt(0)}
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
                      <button disabled={manualSaving || !templateState.ready} onClick={() => saveEdit(user.id)} className="p-1.5 rounded-md hover:bg-accent text-green-600 transition-colors disabled:opacity-50" title={t('common.save')}>
                        <Check size={15} />
                      </button>
                      <button disabled={manualSaving} onClick={cancelEdit} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors disabled:opacity-50" title={t('common.cancel')}>
                        <X size={15} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Content */}
                <CardContent className="p-4 space-y-3">
                  {templateState.template.fields.filter(field => field.enabled).map(field => {
                    const style = FIELD_STYLES[field.key] ?? { icon: FileText, color: 'text-primary' };
                    const Icon = style.icon;
                    const label = teamIntroFieldLabel(field, t);
                    const source = isEditing ? editDraft : manual;
                    const rawValue = isManualTextKey(field.key) ? source?.[field.key] : source?.custom_fields?.[field.key];
                    const value = typeof rawValue === 'string' ? rawValue : '';
                    const inputId = `manual-${user.id}-${field.key}`;

                    return (
                      <section key={field.key} aria-label={label}>
                        <div className="flex items-center gap-1.5 mb-1">
                          <Icon size={13} className={`${style.color} shrink-0`} aria-hidden="true" />
                          <label htmlFor={isEditing && field.key !== 'projects' ? inputId : undefined} className="text-xs font-medium text-muted-foreground">{label}</label>
                        </div>
                        {field.key === 'projects' ? (
                          <>
                            {field.hint && <p className="text-xs text-muted-foreground mb-1">{field.hint}</p>}
                            {projectNames.length > 0 ? (
                              <ul className="list-disc pl-5 space-y-1 text-sm text-foreground/80 leading-relaxed marker:text-muted-foreground/60">
                                {projectNames.map(name => <li key={name} className="[overflow-wrap:anywhere]">{name}</li>)}
                              </ul>
                            ) : <p className="text-sm text-muted-foreground/50 italic">{t('teamIntro.noProjects')}</p>}
                          </>
                        ) : isEditing ? (
                          <textarea
                            id={inputId}
                            value={value}
                            disabled={manualSaving}
                            placeholder={field.hint}
                            onChange={e => setEditDraft(prev => isManualTextKey(field.key)
                              ? { ...prev, [field.key]: e.target.value }
                              : { ...prev, custom_fields: { ...prev.custom_fields, [field.key]: e.target.value } })}
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
                      </section>
                    );
                  })}
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
