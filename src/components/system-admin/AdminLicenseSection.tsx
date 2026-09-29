import { CheckCircle2, ExternalLink, Scale } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SOURCE_URL, editionText } from '@/lib/edition';

// Open-source edition: replaces the old license-key panel with edition info
// and a link to the source code (AGPL-3.0 §13).
const AdminLicenseSection = () => {
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground flex items-center gap-2 border-b border-border pb-2">
        <Scale size={18} className="text-primary" />
        {editionText({ 'zh-TW': '版本資訊', 'zh-CN': '版本信息', en: 'Edition' })}
      </h2>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <CheckCircle2 size={20} className="text-green-500" />
            {editionText({ 'zh-TW': 'LIVO 開源版', 'zh-CN': 'LIVO 开源版', en: 'LIVO open-source edition' })}
          </CardTitle>
          <CardDescription>
            {editionText({
              'zh-TW': '以 AGPL-3.0 授權釋出。所有功能都已開放，不需要授權金鑰。',
              'zh-CN': '以 AGPL-3.0 授权发布。所有功能都已开放，不需要授权密钥。',
              en: 'Released under the AGPL-3.0. Every feature is available and no license key is needed.',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary hover:underline break-all"
          >
            <ExternalLink size={14} className="flex-shrink-0" />
            {editionText({ 'zh-TW': '原始碼', 'zh-CN': '源代码', en: 'Source code' })}：{SOURCE_URL}
          </a>
          <p className="text-xs text-muted-foreground">
            {editionText({
              'zh-TW': '如果你修改了 LIVO，再透過網路提供給其他人使用，AGPL-3.0 要求你也提供修改後的原始碼。',
              'zh-CN': '如果你修改了 LIVO，再通过网络提供给其他人使用，AGPL-3.0 要求你也提供修改后的源代码。',
              en: 'If you modify LIVO and let other people use it over a network, the AGPL-3.0 requires you to offer them your modified source code.',
            })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default AdminLicenseSection;
