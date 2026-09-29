import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIContext } from '@/context/UIContext';
import { Rocket, Zap, Search, GripHorizontal } from 'lucide-react';

const STORAGE_KEY = 'livo-onboarding-done';

const OnboardingGuide = () => {
  const { t } = useTranslation();
  const { setShowCreateTask } = useUIContext();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    setVisible(false);
  };

  const handleCreateTask = () => {
    dismiss();
    setShowCreateTask(true);
  };

  const steps = [
    {
      icon: <Rocket size={40} className="text-primary" />,
      title: t('onboarding.welcomeTitle'),
      desc: t('onboarding.welcomeDesc'),
    },
    {
      icon: <Zap size={40} className="text-primary" />,
      title: t('onboarding.quickStartTitle'),
      tips: [
        { icon: <GripHorizontal size={16} className="text-primary shrink-0" />, text: t('onboarding.tip1') },
        { icon: <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">⌘N</span>, text: t('onboarding.tip2') },
        { icon: <Search size={16} className="text-primary shrink-0" />, text: t('onboarding.tip3') },
      ],
    },
    {
      icon: <Rocket size={40} className="text-primary" />,
      title: t('onboarding.readyTitle'),
      desc: t('onboarding.readyDesc'),
    },
  ];

  const current = steps[step];

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-6 pt-8 pb-6 flex flex-col items-center text-center">
          <div className="mb-4">{current.icon}</div>
          <h2 className="text-lg font-bold text-foreground mb-2">{current.title}</h2>
          {current.desc && <p className="text-sm text-muted-foreground leading-relaxed">{current.desc}</p>}
          {'tips' in current && current.tips && (
            <div className="w-full mt-4 space-y-3 text-left">
              {current.tips.map((tip, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5 bg-muted/40 rounded-lg">
                  {tip.icon}
                  <span className="text-sm text-foreground">{tip.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Dots */}
        <div className="flex items-center justify-center gap-1.5 pb-4">
          {steps.map((_, i) => (
            <div key={i} className={`w-2 h-2 rounded-full transition-colors ${i === step ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
          ))}
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex gap-2">
          {step < steps.length - 1 ? (
            <>
              <button onClick={dismiss} className="flex-1 px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted transition-colors">
                {t('onboarding.skip')}
              </button>
              <button onClick={() => setStep(s => s + 1)} className="flex-1 px-4 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">
                {t('onboarding.next')}
              </button>
            </>
          ) : (
            <>
              <button onClick={dismiss} className="flex-1 px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted transition-colors">
                {t('onboarding.understood')}
              </button>
              <button onClick={handleCreateTask} className="flex-1 px-4 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">
                {t('onboarding.createFirst')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default OnboardingGuide;
