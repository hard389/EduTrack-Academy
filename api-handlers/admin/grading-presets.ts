import type { ApiDispatchRequest, ApiDispatchResponse } from '../../server/apiRouteDispatcher.js';
import {
  getAdminGradingPresets,
  saveAdminGradingPresets,
  sendGradingPresetsError,
  type GradingPresetsRequest,
} from '../../server/gradingPresets.js';

export default async function handler(req: ApiDispatchRequest, res: ApiDispatchResponse): Promise<unknown> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const request = req as GradingPresetsRequest;
    if (req.method === 'GET') return res.status(200).json(await getAdminGradingPresets(request));
    if (req.method === 'PUT') return res.status(200).json(await saveAdminGradingPresets(request));
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  } catch (error) {
    return sendGradingPresetsError(res, error);
  }
}
