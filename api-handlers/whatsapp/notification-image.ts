import { getFirebaseAdminFirestore } from "../../server/firebaseAdmin.js";
import {
  renderWhatsAppNotificationPng,
  verifyWhatsAppNotificationImageLink,
} from "../../server/whatsappNotificationImage.js";

type Request = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
};

type Response = {
  setHeader(name: string, value: string): void;
  status(code: number): Response;
  send(data: Buffer | string): unknown;
  json(data: unknown): unknown;
};

function queryText(query: Request["query"], key: string): string {
  const value = query?.[key];
  return typeof value === "string" ? value : "";
}

export default async function handler(req: Request, res: Response): Promise<unknown> {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const payload = await verifyWhatsAppNotificationImageLink({
      db: getFirebaseAdminFirestore(),
      mediaId: queryText(req.query, "id"),
      expiresAt: queryText(req.query, "exp"),
      signature: queryText(req.query, "sig"),
    });
    if (!payload) return res.status(404).json({ success: false, error: "This image link is invalid or expired." });

    const png = await renderWhatsAppNotificationPng(payload);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(png.length));
    res.setHeader("Content-Disposition", 'inline; filename="edutrack-whatsapp-notification.png"');
    return res.status(200).send(png);
  } catch (error) {
    console.error("[WhatsAppNotificationImage] Image request failed.", error instanceof Error ? error.name : "UnknownError");
    return res.status(500).json({ success: false, error: "The notification image could not be generated." });
  }
}
