import type { CustomerApiRequest, CustomerApiResponse } from "../../../../server/adminCustomers.js";
import {
  sendCustomerApiError,
  sendCustomerPasswordReset,
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
    const result = await sendCustomerPasswordReset(req);
    return res.status(200).json({
      success: true,
      uid: result.uid,
      message: "Password-reset email request accepted by Firebase.",
    });
  } catch (error) {
    return sendCustomerApiError(res, error);
  }
}
