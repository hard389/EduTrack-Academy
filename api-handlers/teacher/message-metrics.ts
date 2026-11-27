import type { TeacherApiRequest } from '../../server/teacherAuth.js';
import { getTeacherMessageMetrics, sendTeacherMessageMetricsError } from '../../server/teacherMessageMetrics.js';

type Request = TeacherApiRequest & { method?: string };
type Response = { setHeader(name: string, value: string): void; status(code: number): Response; json(data: unknown): unknown };
export default async function handler(req: Request, res: Response): Promise<unknown> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ success: false, error: 'Method not allowed.' }); }
  try { return res.status(200).json(await getTeacherMessageMetrics(req)); }
  catch (error) { return sendTeacherMessageMetricsError(res, error); }
}
