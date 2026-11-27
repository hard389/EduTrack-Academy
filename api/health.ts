type ApiRequest = {
  method?: string;
};

type ApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(data: unknown): ApiResponse;
};

export default function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  return res.status(200).json({
    success: true,
    service: "EduTrack API",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
}
