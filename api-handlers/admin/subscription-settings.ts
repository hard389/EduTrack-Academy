import type { SubscriptionSettingsRequest, SubscriptionSettingsResponse } from '../../server/adminSubscriptionSettings.js';
import {
  getAdminSubscriptionSettings,
  saveAdminSubscriptionSettings,
  sendSubscriptionSettingsError,
} from '../../server/adminSubscriptionSettings.js';

export default async function handler(req: SubscriptionSettingsRequest, res: SubscriptionSettingsResponse): Promise<unknown> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json(await getAdminSubscriptionSettings(req));
    if (req.method === 'PUT') return res.status(200).json(await saveAdminSubscriptionSettings(req));
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  } catch (error) {
    return sendSubscriptionSettingsError(res, error);
  }
}
