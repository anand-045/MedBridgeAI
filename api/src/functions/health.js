const { app } = require("@azure/functions");

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => {
    return {
      jsonBody: {
        status: "ok",
        configured: {
          speech: Boolean(process.env.SPEECH_KEY && process.env.SPEECH_REGION),
          vision: Boolean(process.env.VISION_KEY && process.env.VISION_ENDPOINT),
          language: Boolean(process.env.LANGUAGE_KEY && process.env.LANGUAGE_ENDPOINT),
          rag: Boolean(process.env.AZURE_OPENAI_KEY && process.env.AZURE_SEARCH_KEY),
        },
      },
    };
  },
});