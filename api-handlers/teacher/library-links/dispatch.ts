import type { TeacherApiRequest } from '../../../server/teacherAuth.js';
import { dispatchLibraryLinkWhatsApp, sendLibraryLinkWhatsAppApiError } from '../../../server/libraryLinkWhatsApp.js';

type Request = TeacherApiRequest & { method?: string; body?: unknown };
type Response = { setHeader(name: string, value: string): void; status(code: number): Response; json(data: unknown): unknown };

export default async function handler(req: Request, res: Response): Promise<unknown> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }
  try { return res.status(200).json(await dispatchLibraryLinkWhatsApp(req)); }
  catch (error) { return sendLibraryLinkWhatsAppApiError(res, error); }
}
