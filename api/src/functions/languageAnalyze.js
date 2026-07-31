const { app } = require("@azure/functions");

const API_VERSION = "2023-04-01";
const MAX_CHARS = 5000;

async function callLanguage(kind, text, endpoint, key) {
  const url = `${endpoint}/language/:analyze-text?api-version=${API_VERSION}`;
  const payload = {
    kind,
    parameters: { modelVersion: "latest" },
    analysisInput: { documents: [{ id: "1", language: "en", text }] },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": key },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`${kind} failed: ${res.status} ${detail}`);
  }
  return res.json();
}

/*
  Same three calls as the original Python Function: sentiment, key phrases,
  and named entities — used together to build the Medical Summary card.
*/
app.http("languageAnalyze", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "languageAnalyze",
  handler: async (request, context) => {
    const endpoint = (process.env.LANGUAGE_ENDPOINT || "").replace(/\/$/, "");
    const key = process.env.LANGUAGE_KEY || "";

    if (!endpoint || !key) {
      return { status: 500, jsonBody: { error: "LANGUAGE_ENDPOINT / LANGUAGE_KEY are not configured." } };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const text = (body.text || "").trim();
    if (!text) return { status: 400, jsonBody: { error: 'Request body must include non-empty "text".' } };
    if (text.length > MAX_CHARS) {
      return { status: 400, jsonBody: { error: `Text must be ${MAX_CHARS} characters or fewer.` } };
    }

    try {
      const [sentimentRes, keyphraseRes, entityRes] = await Promise.all([
        callLanguage("SentimentAnalysis", text, endpoint, key),
        callLanguage("KeyPhraseExtraction", text, endpoint, key),
        callLanguage("EntityRecognition", text, endpoint, key),
      ]);

      const sentimentDoc = sentimentRes.results.documents[0];
      const keyphraseDoc = keyphraseRes.results.documents[0];
      const entityDoc = entityRes.results.documents[0];

      return {
        jsonBody: {
          sentiment: sentimentDoc.sentiment,
          confidenceScores: sentimentDoc.confidenceScores,
          keyPhrases: keyphraseDoc.keyPhrases || [],
          entities: (entityDoc.entities || []).map((e) => ({ text: e.text, category: e.category })),
        },
      };
    } catch (err) {
      context.error("Azure AI Language call failed:", err.message);
      return { status: 502, jsonBody: { error: "Azure AI Language request failed. Check key/endpoint/quota." } };
    }
  },
});