import type { ApiDispatchRequest, ApiDispatchResponse } from '../../server/apiRouteDispatcher.js';
import { getTeacherGradingPresets, sendGradingPresetsError } from '../../server/gradingPresets.js';

export default async function handler(req: ApiDispatchRequest, res: ApiDispatchResponse): Promise<unknown> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }
  try {
    return res.status(200).json(await getTeacherGradingPresets(req));
  } catch (error) {
    return sendGradingPresetsError(res, error);
  }
}
