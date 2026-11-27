import {
  AdminApiAuthError,
  FirebaseAdminConfigurationError,
  verifyAdminRequest,
} from "../../server/firebaseAdmin.js";

type ApiRequest = {
  method?: string;
  headers: { authorization?: string | string[] };
};

type ApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(data: unknown): ApiResponse;
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    const admin = await verifyAdminRequest(req);

    return res.status(200).json({
      success: true,
      service: "EduTrack Admin API",
      authenticated: true,
      admin: true,
      email: admin.email,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof FirebaseAdminConfigurationError) {
      return res.status(503).json({
        success: false,
        error: "Firebase Admin server settings are not configured.",
      });
    }

    if (error instanceof AdminApiAuthError) {
      return res.status(error.status).json({
        success: false,
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Unable to verify administrator.",
    });
  }
}
