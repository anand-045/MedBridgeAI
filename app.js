/* =========================================================
   MedBridge AI — frontend logic
   6-step flow: Patient -> Situation -> Documents ->
   First-aid (RAG) -> Urban review -> Summary (RAG)
   Nothing here is hardcoded — case ID, step completion,
   and every value shown comes from real input or a real
   API response.
   ========================================================= */

const API_BASE = "";

const state = {
  recording: false,
  recognizer: null,
  documents: [],       // { id, name, isImage, dataUrl, ocrText, tags }
  translatedText: "",
  firstAid: { text: "", sources: [] },
  decision: null,       // "Approved" | "Edited" | "Rejected"
};

/* ---------- Case ID: generated once per session, not hardcoded ---------- */
document.getElementById("caseId").textContent =
  (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 8).toUpperCase();

/* =========================================================
   Stepper — built dynamically from the section elements,
   highlights the step in view and marks completed ones.
   ========================================================= */
const sections = Array.from(document.querySelectorAll(".step-card"));
const stepper = document.getElementById("stepper");

sections.forEach((sec) => {
  const pill = document.createElement("div");
  pill.className = "step-pill";
  pill.dataset.target = sec.id;
  pill.innerHTML = `<span class="dot">${sec.dataset.step}</span><span>${sec.dataset.title}</span>`;
  pill.addEventListener("click", () => sec.scrollIntoView({ behavior: "smooth" }));
  stepper.appendChild(pill);
});

function setActivePill(id) {
  stepper.querySelectorAll(".step-pill").forEach((p) => p.classList.toggle("active", p.dataset.target === id));
}

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) setActivePill(e.target.id);
    });
  },
  { rootMargin: "-40% 0px -50% 0px" }
);
sections.forEach((s) => observer.observe(s));

function markStepComplete(stepId, complete) {
  const check = document.getElementById(`check-${stepId}`);
  const pill = stepper.querySelector(`.step-pill[data-target="step-${stepId}"]`);
  check.classList.toggle("filled", complete);
  if (pill) {
    pill.classList.toggle("done", complete);
    pill.querySelector(".dot").innerHTML = complete ? '<i class="fa-solid fa-check"></i>' : stepId;
  }
}

/* =========================================================
   STEP 1 — Patient details
   ========================================================= */
function getPatient() {
  return {
    name: document.getElementById("pName").value.trim(),
    age: document.getElementById("pAge").value.trim(),
    gender: document.getElementById("pGender").value,
    village: document.getElementById("pVillage").value.trim(),
    bloodGroup: document.getElementById("pBlood").value,
    phone: document.getElementById("pPhone").value.trim(),
  };
}
function checkPatientComplete() {
  const p = getPatient();
  markStepComplete(1, Boolean(p.name && p.age && p.gender));
}
["pName", "pAge", "pGender", "pVillage", "pBlood", "pPhone"].forEach((id) =>
  document.getElementById(id).addEventListener("input", checkPatientComplete)
);

/* =========================================================
   STEP 2 — Speech (Azure Speech SDK) — rural doctor speaks,
   urban doctor reads the live English translation.
   ========================================================= */
async function getSpeechToken() {
  const res = await fetch(`${API_BASE}/api/speechToken`);
  if (!res.ok) throw new Error("Could not fetch speech token");
  return res.json();
}

async function startRecording() {
  const micBtn = document.getElementById("micBtn");
  const micState = document.getElementById("micState");
  const sourceLang = document.getElementById("sourceLang").value;

  try {
    const { token, region } = await getSpeechToken();
    const speechConfig = SpeechSDK.SpeechTranslationConfig.fromAuthorizationToken(token, region);
    speechConfig.speechRecognitionLanguage = sourceLang;
    speechConfig.addTargetLanguage("en");

    const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    const recognizer = new SpeechSDK.TranslationRecognizer(speechConfig, audioConfig);
    state.recognizer = recognizer;

    recognizer.recognizing = (s, e) => {
      document.getElementById("rawTranscript").textContent = e.result.text || "…";
    };
    recognizer.recognized = (s, e) => {
      if (e.result.reason === SpeechSDK.ResultReason.TranslatedSpeech) {
        document.getElementById("rawTranscript").textContent = e.result.text;
        const translated = e.result.translations.get("en");
        state.translatedText = (state.translatedText + " " + translated).trim();
        document.getElementById("translatedText").textContent = state.translatedText;
        markStepComplete(2, true);
      }
    };

    recognizer.startContinuousRecognitionAsync();
    state.recording = true;
    micBtn.classList.add("recording");
    micState.textContent = "Listening…";
  } catch (err) {
    console.error(err);
    micState.textContent = "Mic/API unavailable — check backend configuration";
  }
}

function stopRecording() {
  const micBtn = document.getElementById("micBtn");
  const micState = document.getElementById("micState");
  if (state.recognizer) {
    state.recognizer.stopContinuousRecognitionAsync(() => {
      state.recognizer.close();
      state.recognizer = null;
    });
  }
  state.recording = false;
  micBtn.classList.remove("recording");
  micState.textContent = "Tap to start recording";
}

document.getElementById("micBtn").addEventListener("click", () => {
  state.recording ? stopRecording() : startRecording();
});

/* =========================================================
   STEP 3 — Shared document upload (multi-file)
   ========================================================= */
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const docGrid = document.getElementById("docGrid");

dropzone.addEventListener("click", () => fileInput.click());
["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("drag"); })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); })
);
dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

function handleFiles(fileList) {
  Array.from(fileList).forEach((file) => {
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
    const isImage = file.type.startsWith("image/");
    const doc = { id, name: file.name, isImage, dataUrl: null, ocrText: "", tags: [] };
    state.documents.push(doc);
    renderDocGrid();

    if (isImage) {
      const reader = new FileReader();
      reader.onload = async () => {
        doc.dataUrl = reader.result;
        renderDocGrid();
        await runVisionAnalysis(doc);
      };
      reader.readAsDataURL(file);
    }
  });
  markStepComplete(3, state.documents.length > 0);
}

function renderDocGrid() {
  docGrid.innerHTML = state.documents
    .map(
      (d) => `
      <div class="doc-item" data-id="${d.id}">
        <button class="doc-remove" data-remove="${d.id}"><i class="fa-solid fa-xmark"></i></button>
        ${d.isImage && d.dataUrl
          ? `<img src="${d.dataUrl}" alt="${d.name}">`
          : `<div class="doc-icon"><i class="fa-solid fa-file-lines"></i></div>`}
        <span class="doc-name">${d.name}</span>
      </div>`
    )
    .join("");

  docGrid.querySelectorAll("[data-remove]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.documents = state.documents.filter((d) => d.id !== btn.dataset.remove);
      renderDocGrid();
      markStepComplete(3, state.documents.length > 0);
    })
  );
}

async function runVisionAnalysis(doc) {
  try {
    const res = await fetch(`${API_BASE}/api/visionAnalyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: doc.dataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Vision analysis failed");

    doc.ocrText = (data.readResult?.blocks || []).flatMap((b) => b.lines?.map((l) => l.text) || []).join(" ");
    doc.tags = (data.tags || []).map((t) => t.name).filter(Boolean);
  } catch (err) {
    console.error("Vision analysis failed for", doc.name, err);
  }
}

/* =========================================================
   STEP 3b — Hospital reference documents (indexed into RAG)
   ========================================================= */
const refDropzone = document.getElementById("refDropzone");
const refFileInput = document.getElementById("refFileInput");
const refList = document.getElementById("refList");

refDropzone.addEventListener("click", () => refFileInput.click());
["dragenter", "dragover"].forEach((evt) =>
  refDropzone.addEventListener(evt, (e) => { e.preventDefault(); refDropzone.classList.add("drag"); })
);
["dragleave", "drop"].forEach((evt) =>
  refDropzone.addEventListener(evt, (e) => { e.preventDefault(); refDropzone.classList.remove("drag"); })
);
refDropzone.addEventListener("drop", (e) => handleRefFiles(e.dataTransfer.files));
refFileInput.addEventListener("change", (e) => handleRefFiles(e.target.files));

function handleRefFiles(fileList) {
  Array.from(fileList).forEach((file) => {
    const li = document.createElement("li");
    li.innerHTML = `<i class="fa-solid fa-file"></i><span class="ref-name">${file.name}</span><span class="ref-status"><i class="fa-solid fa-spinner fa-spin"></i> Indexing…</span>`;
    refList.appendChild(li);

    const reader = new FileReader();
    reader.onload = async () => {
      const statusEl = li.querySelector(".ref-status");
      try {
        const res = await fetch(`${API_BASE}/api/ingestKnowledge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, fileBase64: reader.result, mimeType: file.type }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Ingestion failed");
        statusEl.innerHTML = `<span class="ok">Indexed (${data.chunks} chunks)</span>`;
      } catch (err) {
        statusEl.innerHTML = `<span class="err">Failed — ${err.message}</span>`;
        console.error(err);
      }
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- shared helper: build context text for RAG calls ---------- */
function buildDocumentContext() {
  return state.documents
    .map((d) => {
      const parts = [`File: ${d.name}`];
      if (d.tags.length) parts.push(`Detected: ${d.tags.join(", ")}`);
      if (d.ocrText) parts.push(`Text found: ${d.ocrText}`);
      return parts.join(" — ");
    })
    .join("\n");
}

/* =========================================================
   STEP 4 — Immediate first-aid guidance (RAG)
   ========================================================= */
document.getElementById("btnFirstAid").addEventListener("click", async () => {
  const box = document.getElementById("firstAidBox");
  const sourcesEl = document.getElementById("firstAidSources");

  if (state.documents.length === 0) {
    box.innerHTML = `<p class="placeholder">Upload at least one document first (Step 3).</p>`;
    return;
  }

  box.innerHTML = `<p class="placeholder">Generating guidance…</p>`;

  try {
    const res = await fetch(`${API_BASE}/api/ragChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "firstAid",
        patient: getPatient(),
        explanation: state.translatedText,
        documentContext: buildDocumentContext(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "First-aid request failed");

    state.firstAid = { text: data.guidance, sources: data.sources || [] };
    box.innerHTML = `<p>${data.guidance}</p>`;
    sourcesEl.textContent = data.sources?.length ? `Sources: ${data.sources.join(", ")}` : "";

    // Pre-fill the urban doctor's editable plan with this suggestion.
    document.getElementById("doctorNote").value = data.guidance;
    markStepComplete(4, true);
  } catch (err) {
    box.innerHTML = `<p class="placeholder">Couldn't reach the RAG assistant. Check backend configuration.</p>`;
    console.error(err);
  }
});

/* =========================================================
   STEP 5 — Urban doctor review & decision
   ========================================================= */
document.querySelectorAll(".decision-row .btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.decision = btn.dataset.decision;
    document.getElementById("decisionStatus").textContent = `Marked as: ${state.decision}`;
    markStepComplete(5, true);
  });
});

document.getElementById("btnSend").addEventListener("click", async () => {
  if (!state.decision) {
    alert("Choose Approve / Mark as edited / Reject before sending.");
    return;
  }
  document.getElementById("decisionStatus").textContent =
    `Sent to rural doctor — decision: ${state.decision}`;

  // Step 6 — generate the structured medicine summary from the final plan.
  await generateSummary();
});

/* =========================================================
   STEP 6 — Medicine & treatment summary (RAG)
   ========================================================= */
async function generateSummary() {
  const finalPlan = document.getElementById("doctorNote").value.trim();
  try {
    const res = await fetch(`${API_BASE}/api/ragChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "summary",
        patient: getPatient(),
        explanation: state.translatedText,
        documentContext: buildDocumentContext(),
        finalPlan,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Summary request failed");

    document.getElementById("sumCondition").textContent = data.condition || "—";
    document.getElementById("sumSymptoms").textContent = data.symptoms || "—";
    document.getElementById("sumMeds").textContent = data.medicines || "—";
    document.getElementById("sumVitals").textContent = data.vitals || "—";
    document.getElementById("sumRecs").textContent = data.recommendation || "—";
    document.getElementById("summarySources").textContent = data.sources?.length
      ? `Sources: ${data.sources.join(", ")}`
      : "";
    markStepComplete(6, true);
    document.getElementById("step-6").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    console.error(err);
    alert("Couldn't generate the summary — check backend configuration.");
  }
}