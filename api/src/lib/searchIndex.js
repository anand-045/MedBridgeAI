/*
  Shared helpers for Azure AI Search — used by both ragChat.js (querying)
  and ingestKnowledge.js (indexing hospital reference documents).
*/

async function ensureIndexExists(endpoint, key, indexName) {
  // PUT is create-or-update in Azure AI Search — calling this every time
  // (not just when the index is missing) means adding a field like docType
  // later automatically patches any index that was created before that
  // field existed, instead of silently failing against a stale schema.
  const url = `${endpoint}/indexes/${indexName}?api-version=2023-11-01`;
  const body = {
    name: indexName,
    fields: [
      { name: "id", type: "Edm.String", key: true, filterable: true },
      { name: "content", type: "Edm.String", searchable: true },
      { name: "source", type: "Edm.String", filterable: true, searchable: true },
      { name: "docType", type: "Edm.String", filterable: true }, // "reference" | "patient"
    ],
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "api-key": key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Could not create/update index: ${res.status} ${await res.text()}`);
  }
}

function chunkText(text, chunkSize = 1000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

async function uploadDocuments(endpoint, key, indexName, documents) {
  const url = `${endpoint}/indexes/${indexName}/docs/index?api-version=2023-11-01`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": key },
    body: JSON.stringify({ value: documents.map((d) => ({ "@search.action": "mergeOrUpload", ...d })) }),
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { ensureIndexExists, chunkText, uploadDocuments };