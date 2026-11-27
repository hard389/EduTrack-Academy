export function normalizeAcademyEmail(value: unknown): string;
export function isAllowedAcademyEmail(value: unknown): boolean;
export function normalizeAcademyId(value: unknown): string;
export function nextAcademyIdFromCounter(counterData: Record<string, unknown> | null | undefined): number;
export function isStrongAcademyPassword(value: unknown): boolean;
export function isAcademyRole(value: unknown): value is 'academy_admin' | 'teacher';
export function isActiveAcademyMembership(args: {
  academy: Record<string, unknown> | null | undefined;
  membership: Record<string, unknown> | null | undefined;
  mapping: Record<string, unknown> | null | undefined;
  uid: string;
  email: string;
  role: 'academy_admin' | 'teacher';
}): boolean;
