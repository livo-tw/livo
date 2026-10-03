import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import UserSelect from '@/components/UserSelect';
import { qaId, type QaClient } from '@/lib/qa/client';
import type { QaCoordination } from '@/lib/qa/domain';
import { QaSection, qaButton, qaPrimary } from './QaFields';

export default function QaCoordinatorSettings({ client, projectId, onSaved, onClose }: {
  client: QaClient; projectId: string; onSaved: (value: QaCoordination) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<QaCoordination | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const saving = useRef(false);
  const intent = useRef<{ signature: string; id: string } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const epoch = ++generation.current;
    setValue(null); setError(''); intent.current = null;
    void client.getCoordination(projectId).then(result => { if (epoch === generation.current) { setValue(result); setSelected(result.coordinatorId || ''); } }).catch(() => { if (epoch === generation.current) setError('qaHandoff.loadFailed'); });
    return () => { generation.current++; };
  }, [client, projectId, reload]);
  const save = async () => {
    if (!value || saving.current) return;
    saving.current = true; setBusy(true); setError('');
    const epoch = generation.current;
    const signature = JSON.stringify([projectId, value.version, selected]);
    if (intent.current?.signature !== signature) intent.current = { signature, id: qaId() };
    try {
      const saved = await client.saveCoordination(projectId, selected || null, value.version, intent.current.id);
      if (epoch !== generation.current) return;
      intent.current = null; setValue(saved); onSaved(saved);
    } catch (failure) { if (epoch === generation.current) setError((failure as { status?: number })?.status === 409 ? 'qaHandoff.coordinatorConflict' : 'qaHandoff.saveFailed'); }
    finally { saving.current = false; if (epoch === generation.current) setBusy(false); }
  };
  return <QaSection title={t('qaHandoff.coordinatorTitle')}>
    <p className="mb-3 text-sm text-muted-foreground">{t('qaHandoff.coordinatorHint')}</p>
    {error && <div role="alert" className="mb-3 text-sm text-destructive">{t(error)}</div>}
    {!value ? <button className={qaButton} type="button" onClick={() => setReload(previous => previous + 1)}>{t('qa.refresh')}</button> : <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy} className="space-y-3">
      <UserSelect name="coordinatorId" label={t('qaHandoff.coordinatorTitle')} activeOnly allowEmpty disabled={busy} value={selected} onChange={setSelected} emptyLabel={t('qaHandoff.noCoordinator')} />
      <button className={qaPrimary} type="submit" disabled={selected === (value.coordinatorId || '')}>{t('qa.save')}</button> <button className={qaButton} type="button" onClick={onClose}>{t('qa.cancel')}</button>
    </fieldset></form>}
  </QaSection>;
}
