import { useTranslation } from 'react-i18next';
import { knowledgeImportMessages } from '@/i18n/knowledgeImport';
export function useKnowledgeImportText() {
  const {t,i18n}=useTranslation();const language=i18n?.language||'en';const locale=language.startsWith('zh-CN')?'zh-CN':language.startsWith('zh')?'zh-TW':'en';
  return (key:string)=>t(`kbImport.${key}`,{defaultValue:knowledgeImportMessages[locale][key]||knowledgeImportMessages[locale].unknownError});
}
