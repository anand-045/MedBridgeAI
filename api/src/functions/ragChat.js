const { app } = require("@azure/functions");
const { ensureIndexExists } = require("../lib/searchIndex");

/*
  Single RAG endpoint, three modes, all grounded in the same Azure AI
  Search index. That index now holds TWO kinds of documents, uploaded
  live through Step 3 of the app (see ingestKnowledge.js):
    - docType "reference": hospital first-aid / treatment protocol files
    - docType "patient":   OCR text pulled from the current patient's
                            uploaded X-ray/scan/photo

    mode: "firstAid" — immediate, temporary first-aid guidance from patient
                        info + translated explanation + uploaded documents
    mode: "summary"  — structured medicine/treatment summary once the
                        urban doctor has approved/edited/rejected a plan
    mode: "ask"       — free-form question (kept for flexibility)
*/

async function searchKnowledgeBase(query, endpoint, key, indexName, top = 3) {
  await ensureIndexExists(endpoint, key, indexName);
  const res = await fetch(`${endpoint}/indexes/${indexName}/docs/search?api-version=2023-11-01`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": key },
    body: JSON.stringify({ search: query, top }),
  });
  if (!res.ok) throw new Error(`Search failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.value || [];
}

async function askOpenAI(systemPrompt, userPrompt, endpoint, key, deployment, apiVersion) {
  const res = await fetch(
    `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 500,
        temperature: 0.3,
      }),
    }
  );
  if (!res.ok) throw new Error(`OpenAI call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function buildCaseText(patient, explanation, documentContext, finalPlan) {
  const lines = [];
  if (patient) {
    lines.push(
      `Patient: ${patient.name || "unknown"}, age ${patient.age || "unknown"}, gender ${patient.gender || "unknown"}.`
    );
  }
  if (explanation) lines.push(`Reported situation: ${explanation}`);
  if (documentContext) lines.push(`Uploaded document findings:\n${documentContext}`);
  if (finalPlan) lines.push(`Urban doctor's final plan: ${finalPlan}`);
  return lines.join("\n");
}

app.http("ragChat", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ragChat",
  handler: async (request, context) => {
    const searchEndpoint = (process.env.AZURE_SEARCH_ENDPOINT || "").replace(/\/$/, "");
    const searchKey = process.env.AZURE_SEARCH_KEY || "";
    const indexName = process.env.AZURE_SEARCH_INDEX || "";

    const openaiEndpoint = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
    const openaiKey = process.env.AZURE_OPENAI_KEY || "";
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "";
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-06-01";

    if (!searchEndpoint || !searchKey || !indexName || !openaiEndpoint || !openaiKey || !deployment) {
      return { status: 500, jsonBody: { error: "RAG backend is not fully configured. Check Application settings." } };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const mode = body.mode || "ask";

    try {
      if (mode === "firstAid") {
        const caseText = buildCaseText(body.patient, body.explanation, body.documentContext, null);
        if (!caseText.trim()) {
          return { status: 400, jsonBody: { error: "No patient/explanation/document context provided." } };
        }
        const results = await searchKnowledgeBase(caseText, searchEndpoint, searchKey, indexName);
        const kbContext = results.map((r) => r.content).join(" ");
        const sources = [...new Set(results.map((r) => r.source || "Unknown source"))];

        const guidance = await askOpenAI(
          "You are assisting a rural doctor. Using ONLY the reference context below (your hospital's " +
            "own first-aid and treatment protocol documents), give brief, TEMPORARY first-aid steps to " +
            "stabilize the patient right now, while the case is sent to the urban doctor for a final " +
            "treatment decision. Be explicit that this is interim guidance, not a final diagnosis or " +
            "treatment plan. If the reference context doesn't cover this case, say so clearly instead " +
            "of guessing.\n\n" +
            `Reference context:\n${kbContext}`,
          caseText,
          openaiEndpoint, openaiKey, deployment, apiVersion
        );

        return { jsonBody: { guidance, sources } };
      }

      if (mode === "summary") {
        const caseText = buildCaseText(body.patient, body.explanation, body.documentContext, body.finalPlan);
        const results = await searchKnowledgeBase(caseText, searchEndpoint, searchKey, indexName);
        const kbContext = results.map((r) => r.content).join(" ");
        const sources = [...new Set(results.map((r) => r.source || "Unknown source"))];

        const raw = await askOpenAI(
          "You produce a structured clinical summary for a patient record. Using ONLY the reference " +
            "context and case details below, respond with STRICT JSON only — no markdown, no prose " +
            'outside the JSON — matching exactly this shape: {"condition": "", "symptoms": "", ' +
            '"medicines": "", "vitals": "", "recommendation": ""}. If something is unknown, say "Not specified".\n\n' +
            `Reference context:\n${kbContext}`,
          caseText,
          openaiEndpoint, openaiKey, deployment, apiVersion
        );

        let parsed;
        try {
          parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
        } catch {
          parsed = { condition: "Not specified", symptoms: "Not specified", medicines: "Not specified", vitals: "Not specified", recommendation: raw };
        }

        return { jsonBody: { ...parsed, sources } };
      }

      // mode === "ask" (free-form fallback)
      const question = (body.question || "").trim();
      if (!question) return { status: 400, jsonBody: { error: 'Request body must include non-empty "question".' } };

      const results = await searchKnowledgeBase(question, searchEndpoint, searchKey, indexName);
      if (results.length === 0) {
        return { jsonBody: { answer: "No relevant content found in the medical knowledge base yet.", sources: [] } };
      }
      const kbContext = results.map((r) => r.content).join(" ");
      const sources = [...new Set(results.map((r) => r.source || "Unknown source"))];
      const answer = await askOpenAI(
        "Answer only using the provided context. If the answer is not contained in the context, say so.\n\n" +
          `Context:\n${kbContext}`,
        question,
        openaiEndpoint, openaiKey, deployment, apiVersion
      );
      return { jsonBody: { answer, sources } };
    } catch (err) {
      context.error("RAG request failed:", err.message, err.cause?.message || "");
      return { status: 502, jsonBody: { error: `RAG request failed: ${err.message}${err.cause ? " — " + err.cause.message : ""}` } };
    }
  },
});