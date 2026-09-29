import { useAuthContext } from '@/context/AuthContext';
import { getThemes, type ThemeKey } from '@/lib/themes';

const ThemeSelector = () => {
  const { userTheme, setUserTheme } = useAuthContext();
  const themes = getThemes();

  return (
    <div className="flex items-center gap-3">
      {themes.map(t => (
        <button
          key={t.key}
          onClick={() => setUserTheme(t.key)}
          className={`flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all ${
            userTheme === t.key ? 'border-primary shadow-md scale-105' : 'border-transparent hover:border-border'
          }`}
          title={t.label}
        >
          <div className="w-14 h-10 rounded-md overflow-hidden flex shadow-sm">
            <div className="w-5 h-full" style={{ backgroundColor: t.sidebarColor }} />
            <div className="flex-1 bg-gray-100 flex items-center justify-center">
              <div className="w-5 h-1.5 rounded-full" style={{ backgroundColor: t.accentColor }} />
            </div>
          </div>
          <span className="text-xs font-medium text-foreground">{t.label}</span>
        </button>
      ))}
    </div>
  );
};

export default ThemeSelector;
