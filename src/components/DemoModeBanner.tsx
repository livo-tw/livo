import { exitDemoMode } from '@/lib/demoMode';
import { SOURCE_URL, editionText } from '@/lib/edition';

/**
 * Persistent, non-dismissable banner shown for the whole ?demo=pro preview
 * session. Makes it unmistakable that this is a demo (data is not saved) and
 * points to the source code for running a real instance.
 *
 * Height is fixed at 44px; App.tsx offsets the app below it.
 */
export const DEMO_BANNER_HEIGHT = 44;

const DemoModeBanner = () => {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ height: DEMO_BANNER_HEIGHT }}
      className="fixed top-0 left-0 right-0 z-[10000] flex items-center justify-center gap-x-3 gap-y-0.5 flex-wrap px-4 text-white text-center shadow-lg bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600"
    >
      <span className="text-sm font-semibold whitespace-nowrap">
        <span aria-hidden="true">🎭 </span>
        {editionText({ 'zh-TW': '你正在預覽 LIVO', 'zh-CN': '你正在预览 LIVO', en: "You're previewing LIVO" })}
      </span>
      <span className="text-xs text-white/85 hidden sm:inline whitespace-nowrap">
        {editionText({
          'zh-TW': '展示模式・變更不會儲存',
          'zh-CN': '展示模式・变更不会储存',
          en: 'Demo mode · changes are not saved',
        })}
      </span>
      <a
        href={SOURCE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-bold bg-white text-purple-700 rounded-full px-3 py-1 hover:bg-purple-50 transition-colors whitespace-nowrap"
      >
        {editionText({
          'zh-TW': '免費架在自己的伺服器 · 原始碼',
          'zh-CN': '免费部署在自己的服务器 · 源代码',
          en: 'Self-host it for free · source code',
        })}
      </a>
      <button
        type="button"
        onClick={exitDemoMode}
        className="text-xs underline text-white/80 hover:text-white transition-colors whitespace-nowrap"
      >
        {editionText({ 'zh-TW': '離開展示模式', 'zh-CN': '离开展示模式', en: 'Exit demo' })}
      </button>
    </div>
  );
};

export default DemoModeBanner;
