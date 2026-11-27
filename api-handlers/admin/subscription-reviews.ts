import type { ReviewResponse } from '../../server/adminSubscriptionReviews.js';
import {
  getAdminSubscriptionReviews,
  reviewAdminSubscriptionPayment,
  sendSubscriptionReviewError,
} from '../../server/adminSubscriptionReviews.js';

type ReviewRequest = {
  method?: string;
  headers: { authorization?: string | string[]; [key: string]: string | string[] | undefined };
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

export default async function handler(req: ReviewRequest, res: ReviewResponse): Promise<unknown> {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  try {
    if (req.method === 'GET') return res.status(200).json(await getAdminSubscriptionReviews(req));
    if (req.method === 'POST') return res.status(200).json(await reviewAdminSubscriptionPayment(req));
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  } catch (error) {
    return sendSubscriptionReviewError(res, error);
  }
}
