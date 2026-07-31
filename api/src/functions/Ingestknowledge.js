const { app } = require("@azure/functions");
const { ensureIndexExists, chunkText, uploadDocuments } = require("../lib/searchIndex");

/*
  This is the "live" replacement for the offline Streamlit index_pdf()
  script — hospital staff upload their first-aid / treatment protocol
  documents right in Step 3 of the app, and this function chunks and
  indexes them into Azure AI Search under docType "reference", so
  ragChat.js can ground its suggestions in them immediately.

  Supported inputs:
    - PDF   -> text extracted with pdf-parse
    - TXT   -> used as-is
    - Image -> OCR'd via Azure AI Vision (same Read API as visionAnalyze.js)
*/

async function extractTextFromImage(imageBuffer, visionEndpoint, visionKey) {
  const url = `${visionEndpoint}/computervision/imageanalysis:analyze?api-version=2023-10-01&features=Read`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": visionKey, "Content-Type": "application/octet-stream" },
    body: imageBuffer,
  });
  if (!res.ok) throw new Error(`Vision OCR failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.readResult?.blocks || []).flatMap((b) => b.lines?.map((l) => l.text) || []).join(" ");
}

app.http("ingestKnowledge", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingestKnowledge",
  handler: async (request, context) => {
    const searchEndpoint = (process.env.AZURE_SEARCH_ENDPOINT || "").replace(/\/$/, "");
    const searchKey = process.env.AZURE_SEARCH_KEY || "";
    const indexName = process.env.AZURE_SEARCH_INDEX || "";
    const visionEndpoint = (process.env.VISION_ENDPOINT || "").replace(/\/$/, "");
    const visionKey = process.env.VISION_KEY || "";

    if (!searchEndpoint || !searchKey || !indexName) {
      return { status: 500, jsonBody: { error: "Azure AI Search is not configured. Check Application settings." } };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const { name, fileBase64, mimeType } = body;
    if (!name || !fileBase64) {
      return { status: 400, jsonBody: { error: "Request must include name and fileBase64." } };
    }

    try {
      await ensureIndexExists(searchEndpoint, searchKey, indexName);

      const raw = fileBase64.includes(",") ? fileBase64.split(",")[1] : fileBase64;
      const buffer = Buffer.from(raw, "base64");

      let text = "";
      if (mimeType === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
        const pdfParse = require("pdf-parse");
        const parsed = await pdfParse(buffer);
        text = parsed.text;
      } else if (mimeType?.startsWith("image/")) {
        if (!visionEndpoint || !visionKey) {
          return { status: 500, jsonBody: { error: "Azure Vision is not configured (needed to OCR image reference files)." } };
        }
        text = await extractTextFromImage(buffer, visionEndpoint, visionKey);
      } else {
        text = buffer.toString("utf-8");
      }

      if (!text.trim()) {
        return { status: 400, jsonBody: { error: `No extractable text found in ${name}.` } };
      }

      const chunks = chunkText(text);
      const documents = chunks.map((chunk, i) => ({
        id: `ref-${Buffer.from(name).toString("hex")}-${i}`,
        content: chunk,
        source: name,
        docType: "reference",
      }));

      await uploadDocuments(searchEndpoint, searchKey, indexName, documents);

      return { jsonBody: { indexed: true, chunks: documents.length, source: name } };
    } catch (err) {
      context.error("Knowledge ingestion failed:", err.message);
      return { status: 502, jsonBody: { error: `Ingestion failed: ${err.message}` } };
    }
  },
});