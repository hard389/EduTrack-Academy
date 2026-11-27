import type { SubscriptionApiRequest, SubscriptionApiResponse } from '../../server/adminSubscriptions.js';
import { getAdminSubscriptions, postAdminSubscriptions, sendSubscriptionApiError } from '../../server/adminSubscriptions.js';

export default async function handler(req: SubscriptionApiRequest, res: SubscriptionApiResponse): Promise<unknown> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json(await getAdminSubscriptions(req));
    if (req.method === 'POST') return res.status(200).json(await postAdminSubscriptions(req));
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  } catch (error) {
    return sendSubscriptionApiError(res, error);
  }
}
