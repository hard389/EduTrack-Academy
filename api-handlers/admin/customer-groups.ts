import type { CustomerApiRequest, CustomerApiResponse } from "../../server/adminCustomers.js";
import {
  CustomerApiError,
  archiveCustomerGroup,
  isRecord,
  saveCustomerGroup,
  sendCustomerApiError,
} from "../../server/adminCustomers.js";

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
    if (!isRecord(req.body)) {
      throw new CustomerApiError(400, "A valid JSON request body is required.");
    }

    if (req.body.action === "save") {
      const result = await saveCustomerGroup(req, req.body);
      return res.status(200).json(result);
    }

    if (req.body.action === "archive") {
      const result = await archiveCustomerGroup(req, req.body);
      return res.status(200).json(result);
    }

    throw new CustomerApiError(400, "Unsupported customer group action.");
  } catch (error) {
    return sendCustomerApiError(res, error);
  }
}
