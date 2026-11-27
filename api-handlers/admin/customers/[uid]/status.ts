import type { CustomerApiRequest, CustomerApiResponse } from "../../../../server/adminCustomers.js";
import {
  CustomerApiError,
  isRecord,
  sendCustomerApiError,
  updateCustomerActiveStatus,
} from "../../../../server/adminCustomers.js";

export default async function handler(
  req: CustomerApiRequest,
  res: CustomerApiResponse,
): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    if (!isRecord(req.body) || typeof req.body.active !== "boolean") {
      throw new CustomerApiError(400, "The active field must be true or false.");
    }

    const result = await updateCustomerActiveStatus(req, req.body.active);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return sendCustomerApiError(res, error);
  }
}
