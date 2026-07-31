const { app } = require("@azure/functions");

/*
  Mints a short-lived Azure Speech auth token server-side (~10 min validity).
  The raw SPEECH_KEY never reaches the browser — only this temporary token.
  This is the same pattern as the original Express /api/config endpoint,
  just moved into an Azure Function.
*/
app.http("speechToken", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "speechToken",
  handler: async (request, context) => {
    const region = process.env.SPEECH_REGION;
    const key = process.env.SPEECH_KEY;

    if (!region || !key) {
      return { status: 500, jsonBody: { error: "Speech service is not configured on the server." } };
    }

    try {
      const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`, {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": key, "Content-Length": "0" },
      });

      if (!res.ok) {
        const detail = await res.text();
        context.error("Speech token request failed:", res.status, detail);
        return { status: 502, jsonBody: { error: "Unable to retrieve speech token." } };
      }

      const token = await res.text();
      return { jsonBody: { token, region } };
    } catch (err) {
      context.error("Failed to issue speech token:", err.message);
      return { status: 500, jsonBody: { error: "Unable to retrieve speech token." } };
    }
  },
});