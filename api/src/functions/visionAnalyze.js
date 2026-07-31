const { app } = require("@azure/functions");

/*
  Image Analysis 4.0 call — Tags, Read (OCR), People.
  Mirrors the original Flask /analyze route's primary call.
*/
async function analyzeV4(endpoint, key, imageBuffer, imageUrl, features) {
  const url = `${endpoint}/computervision/imageanalysis:analyze?api-version=2023-10-01&features=${features}`;
  const headers = { "Ocp-Apim-Subscription-Key": key };
  if (imageUrl) {
    headers["Content-Type"] = "application/json";
    return fetch(url, { method: "POST", headers, body: JSON.stringify({ url: imageUrl }) });
  }
  headers["Content-Type"] = "application/octet-stream";
  return fetch(url, { method: "POST", headers, body: imageBuffer });
}

app.http("visionAnalyze", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "visionAnalyze",
  handler: async (request, context) => {
    const key = process.env.VISION_KEY || "";
    const endpoint = (process.env.VISION_ENDPOINT || "").replace(/\/$/, "");

    if (!key || !endpoint) {
      return {
        status: 500,
        jsonBody: { error: "Azure Vision not configured. Set VISION_KEY and VISION_ENDPOINT in Application settings." },
      };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const imageUrl = body.url;
    let imageBuffer = null;
    if (body.image_base64) {
      const raw = body.image_base64.includes(",") ? body.image_base64.split(",")[1] : body.image_base64;
      imageBuffer = Buffer.from(raw, "base64");
    } else if (!imageUrl) {
      return { status: 400, jsonBody: { error: "No image URL or image data provided." } };
    }

    try {
      const res = await analyzeV4(endpoint, key, imageBuffer, imageUrl, "Tags,Read,People");
      const result = await res.json().catch(() => ({}));

      if (!res.ok) {
        return { status: res.status, jsonBody: result };
      }

      // Reformat the OCR ("Read") result into simple {blocks:[{lines:[{text}]}]}
      // so the frontend can pull plain text out for the Language AI card.
      const blocks = (result.readResult?.blocks || []).map((b) => ({
        lines: (b.lines || []).map((l) => ({ text: l.text })),
      }));

      return {
        jsonBody: {
          tags: result.tagsResult?.values || [],
          people: result.peopleResult?.values || [],
          readResult: { blocks },
        },
      };
    } catch (err) {
      context.error("Vision request failed:", err.message, err.cause?.message || "");
      return { status: 502, jsonBody: { error: `Request to Azure AI Vision failed: ${err.message}${err.cause ? " — " + err.cause.message : ""}` } };
    }
  },
});