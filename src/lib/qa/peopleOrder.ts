import { compareMemberOrder } from '@/lib/department';

type NamedPerson = { id: string; name: string };
type OrderedQaPerson = NamedPerson & { sortOrder?: number; isExternal?: boolean; qaExternal?: boolean };

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const external = (person: OrderedQaPerson) => person.isExternal === true || person.qaExternal === true;

export function qaPersonSortOrder(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 99;
}

/** The external directory has no position in the internal team-management order. */
export function compareExternalQaPeople(left: NamedPerson, right: NamedPerson): number {
  return compareText(left.name.toLowerCase(), right.name.toLowerCase()) || compareText(left.id, right.id);
}

export function compareQaPeople(left: OrderedQaPerson, right: OrderedQaPerson): number {
  const leftExternal = external(left), rightExternal = external(right);
  if (leftExternal !== rightExternal) return Number(leftExternal) - Number(rightExternal);
  return leftExternal ? compareExternalQaPeople(left, right) : compareMemberOrder(
    { id: left.id, sortOrder: qaPersonSortOrder(left.sortOrder) },
    { id: right.id, sortOrder: qaPersonSortOrder(right.sortOrder) },
  );
}

/** Sort only the supplied authorized records; preserve identity and active flags. */
export function sortQaPeople<T extends OrderedQaPerson>(people: readonly T[]): T[] {
  return [...people].sort(compareQaPeople);
}

export function sortExternalQaPeople<T extends NamedPerson>(people: readonly T[]): T[] {
  return [...people].sort(compareExternalQaPeople);
}
