interface StandupItemCardProps {
  member: { id: string; name: string; avatar: string; color: string; jobTitle: string };
  active: boolean;
  onClick: () => void;
}

export function StandupItemCard({ member, active, onClick }: StandupItemCardProps) {
  return (
    <button
      onClick={onClick}
      aria-label={member.name}
      className={`w-full flex items-center gap-2 px-2 py-2 rounded text-xs transition-colors ${
        active
          ? 'bg-sidebar-active text-sidebar-primary-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-hover'
      }`}
    >
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-bold flex-shrink-0"
        style={{ backgroundColor: member.color, color: '#fff' }}
      >
        {member.avatar}
      </div>
      <div className="text-left overflow-hidden">
        <p className="font-medium truncate">{member.name}</p>
        <p className="text-[10px] opacity-60 truncate">{member.jobTitle}</p>
      </div>
    </button>
  );
}