import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ManualMemberForm, { type ManualMemberFormProps } from './ManualMemberForm';
import MemberInvitationPanel from './MemberInvitationPanel';

interface AddMemberModalProps extends ManualMemberFormProps {
  show: boolean;
  invitationJobTitles?: string[];
}

const AddMemberModal = ({ show, invitationJobTitles = [], ...manualProps }: AddMemberModalProps) => {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [tab, setTab] = useState('invite');
  useEffect(() => { if (show) setTab('invite'); }, [show]);
  if (!show) return null;
  return (
    <Dialog open={show} onOpenChange={open => { if (!open) manualProps.onClose(); }}>
      <DialogContent
        ref={contentRef} aria-describedby={undefined}
        className="flex min-h-0 max-w-md flex-col" style={{ overflow: 'hidden' }}
        onOpenAutoFocus={event => {
          previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
        }}
      >
        <DialogHeader className="min-h-11 justify-center">
          <DialogTitle className="text-base font-bold">{t('memberList.addMemberTitle')}</DialogTitle>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="w-full shrink-0">
            <TabsTrigger value="invite" className="flex-1">{t('memberInvite.inviteTab')}</TabsTrigger>
            <TabsTrigger value="manual" className="flex-1">{t('memberInvite.manualTab')}</TabsTrigger>
          </TabsList>
          <TabsContent value="invite" forceMount hidden={tab !== 'invite'} className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
            <MemberInvitationPanel canEditGrant={manualProps.canEditJobTitle} jobTitles={invitationJobTitles} onClose={manualProps.onClose} />
          </TabsContent>
          <TabsContent value="manual" className="flex min-h-0 flex-1 flex-col">
            <ManualMemberForm {...manualProps} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};

export default AddMemberModal;
