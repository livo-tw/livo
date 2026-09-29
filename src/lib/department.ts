import { User } from '@/types';

export type Department = 'MGR' | 'PM' | 'BE' | 'FE' | 'SRE' | 'QA';

export const DEPARTMENTS: Department[] = ['MGR', 'PM', 'BE', 'FE', 'SRE', 'QA'];

export const deptColors: Record<Department, string> = {
  MGR: 'bg-red-500/15 text-red-600',
  'PM': 'bg-purple-500/15 text-purple-600',
  BE: 'bg-blue-500/15 text-blue-600',
  FE: 'bg-green-500/15 text-green-600',
  SRE: 'bg-cyan-500/15 text-cyan-600',
  QA: 'bg-orange-500/15 text-orange-600',
};

const DEPT_SORT_ORDER: Record<Department, number> = {
  MGR: 0,
  'PM': 1,
  QA: 2,
  BE: 3,
  FE: 4,
  SRE: 5,
};

export function getDepartment(user: { name: string; jobTitle: string } | undefined): Department | null {
  if (!user) return null;
  const jt = user.jobTitle.toLowerCase();
  if (jt.includes('ceo') || jt.includes('總監') || jt.includes('总监')) return 'MGR';
  if (jt.includes('pm') || jt.includes('product') || jt.includes('產品') || jt.includes('产品')) return 'PM';
  if (jt.includes('sre') || jt.includes('devops') || jt.includes('infrastructure')) return 'SRE';
  if (jt.includes('be') || jt.includes('backend') || jt.includes('後端') || jt.includes('后端')) return 'BE';
  if (jt.includes('fe') || jt.includes('frontend') || jt.includes('前端') || jt.includes('mobile')) return 'FE';
  if (jt.includes('qa') || jt.includes('test') || jt.includes('測試') || jt.includes('测试')) return 'QA';
  if (jt.includes('ui') || jt.includes('ux') || jt.includes('design') || jt.includes('設計')) return 'FE';
  if (jt.includes('data') || jt.includes('數據') || jt.includes('数据') || jt.includes('analyst')) return 'BE';
  return null;
}

// Fine-grained ordering within each department
const NAME_ORDER: Record<string, number> = {
  '王建宏': 0,
  '陳雅琪': 10, '林佳蓉': 11, '黃心怡': 12,
  '張靜如': 20, '劉宇涵': 21,
  '許文傑': 30, '鄭志豪': 31, '蔡明軒': 32, '吳佩珊': 33,
  '李承恩': 40, '周冠宇': 41, '楊家瑋': 42, '趙柏翰': 43,
  '謝宗霖': 50, '廖俊傑': 51,
  '蘇怡婷': 60, '葉家銘': 61,
  '鄧雅文': 70, '方彥廷': 71,
};

export function sortUsersByDept<T extends { sortOrder?: number; name: string; jobTitle: string }>(users: T[]): T[] {
  return [...users].sort((a, b) => {
    const oA = a.sortOrder ?? 99;
    const oB = b.sortOrder ?? 99;
    return oA - oB;
  });
}