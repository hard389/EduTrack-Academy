export type QuizResultSnapshotRow = { studentId: string; studentName: string; rollNo: string; marksObtained: number };
export function normalizeQuizWhatsAppPhone(value: unknown): string | null;
export function getQuizResultsConsentedPhone(student: Record<string, unknown> | null | undefined): string | null;
export function parseQuizResultMark(value: unknown, totalMarks: number): { kind: "empty" | "invalid" } | { kind: "valid"; value: number };
export function calculateQuizResultsContentHash(input: { classId: string; quizId: string; topic: string; totalMarks: number; date: string; rows: QuizResultSnapshotRow[] }): string;
export function createQuizResultsDispatchId(input: { tenantId: string; classId: string; quizId: string; contentHash?: string }): string;
export function createQuizResultsRecipientKey(studentId: string): string;
export function createQuizResultMessage(input: { studentName: string; className: string; topic: string; date: string; marksObtained: number; totalMarks: number; teacherName: string }): string;
