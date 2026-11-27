import type { ReviewResponse } from '../../server/adminSubscriptionReviews.js';
import { getAdminSubscriptionReceiptImage, sendSubscriptionReviewError } from '../../server/adminSubscriptionReviews.js';

type ReviewRequest = {
  method?: string;
  headers: { authorization?: string | string[]; [key: string]: string | string[] | undefined };
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

export default async function handler(req: ReviewRequest, res: ReviewResponse): Promise<unknown> {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ success: false, error: 'Method not allowed.' });
    }
    const receipt = await getAdminSubscriptionReceiptImage(req);
    res.setHeader('Content-Type', receipt.mimeType);
    res.setHeader('Content-Disposition', 'inline; filename="subscription-payment-proof"');
    res.setHeader('Content-Length', String(receipt.bytes.length));
    return res.status(200).send(receipt.bytes);
  } catch (error) {
    return sendSubscriptionReviewError(res, error);
  }
}
