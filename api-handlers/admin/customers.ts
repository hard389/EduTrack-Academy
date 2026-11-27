import type { CustomerApiRequest, CustomerApiResponse } from "../../server/adminCustomers.js";
import {
  CustomerApiError,
  archiveManagedCustomer,
  approveManagedCustomer,
  assignManagedCustomerGroup,
  createManagedCustomer,
  getCustomerDirectory,
  isRecord,
  rejectManagedCustomer,
  restoreManagedCustomer,
  sendCustomerApiError,
  updateManagedCustomer,
} from "../../server/adminCustomers.js";

export default async function handler(
  req: CustomerApiRequest,
  res: CustomerApiResponse,
): Promise<unknown> {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      const result = await getCustomerDirectory(req);
      return res.status(200).json(result);
    } catch (error) {
      return sendCustomerApiError(res, error);
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    if (!isRecord(req.body)) {
      throw new CustomerApiError(400, "A valid JSON request body is required.");
    }

    const body = req.body;
    const action = typeof body.action === "string" ? body.action : "";

    let result: unknown;
    switch (action) {
      case "create":
        result = await createManagedCustomer(req, body);
        break;
      case "update":
        result = await updateManagedCustomer(req, body);
        break;
      case "approve":
        result = await approveManagedCustomer(req, body);
        break;
      case "reject":
        result = await rejectManagedCustomer(req, body);
        break;
      case "assign":
        result = await assignManagedCustomerGroup(req, body);
        break;
      case "delete":
        result = await archiveManagedCustomer(req, body);
        break;
      case "restore":
        result = await restoreManagedCustomer(req, body);
        break;
      default:
        throw new CustomerApiError(400, "Unsupported customer action.");
    }

    return res.status(200).json(result);
  } catch (error) {
    return sendCustomerApiError(res, error);
  }
}
