export type AcademyStudentExtraCharge = { id: string; label: string; amount: number; billingFrequency: 'one_time' | 'monthly'; appliesToMonth: string };
export function normalizeAcademyStudentExtraCharges(input: unknown): AcademyStudentExtraCharge[];
