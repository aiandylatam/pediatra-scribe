/**
 * Pediatra Scribe — app.js
 * Lógica completa: grabación, visualizador, llamada al Worker SSE, renderizado SOAP.
 *
 * IMPORTANTE: Cambia WORKER_URL por la URL de tu Cloudflare Worker desplegado.
 */

// ─── Configuración ────────────────────────────────────────────────────────────
const WORKER_URL = "https://pediatra-scribe-api.lucandres.workers.dev";
const MAX_RECORDING_MINUTES = 20;
const WARNING_MINUTES = 18;

// ─── Estado de la app ─────────────────────────────────────────────────────────
const state = {
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  audioBlob: null,
  startTime: null,
  timerInterval: null,
  visualizerRAF: null,
  analyser: null,
  audioCtx: null,
  transcripcion: "",
  notaJson: null,
};

// ─── Refs al DOM ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const screens = {
  record:     $("screen-record"),
  processing: $("screen-processing"),
  result:     $("screen-result"),
};

const btnRecord      = $("btn-record");
const btnProcess     = $("btn-process");
const btnDiscard     = $("btn-discard");
const btnCopy        = $("btn-copy");
const btnNew         = $("btn-new");
const iconMic        = $("icon-mic");
const iconStop       = $("icon-stop");
const btnRecordLabel = $("btn-record-label");
const timerEl        = $("timer");
const timerDisplay   = $("timer-display");
const processZone    = $("process-zone");
const vizContainer   = $("visualizer-container");
const sizeIndicator  = $("size-indicator");
const durationWarn   = $("duration-warning");
const processingStatus = $("processing-status");
const soapPreview    = $("soap-preview");
const soapPreviewContainer = $("soap-preview-container");
const errorToast     = $("error-toast");
const errorMessage   = $("error-message");
const pwaHint        = $("pwa-hint");

// ─── Utilidades ──────────────────────────────────────────────────────────────

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
  window.scrollTo(0, 0);
}

function formatTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showError(msg, durationMs = 5000) {
  errorMessage.textContent = msg;
  errorToast.classList.remove("hidden");
  clearTimeout(showError._timer);
  showError._timer = setTimeout(() => errorToast.classList.add("hidden"), durationMs);
}

// ─── Audio Recorder ───────────────────────────────────────────────────────────

function getBestMimeType() {
  const types = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,       // mono
        sampleRate: 16000,     // 16kHz óptimo para voz
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    if (err.name === "NotAllowedError") {
      showError("Permiso de micrófono denegado. Actívalo en la configuración del navegador.", 8000);
    } else {
      showError(`No se pudo acceder al micrófono: ${err.message}`);
    }
    return;
  }

  // Configurar MediaRecorder
  const mimeType = getBestMimeType();
  const options = { audioBitsPerSecond: 16000 };
  if (mimeType) options.mimeType = mimeType;

  try {
    state.mediaRecorder = new MediaRecorder(stream, options);
  } catch {
    // Fallback sin opciones (Safari)
    state.mediaRecorder = new MediaRecorder(stream);
  }

  state.audioChunks = [];
  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) state.audioChunks.push(e.data);
  };
  state.mediaRecorder.onstop = onRecordingStop;

  state.mediaRecorder.start(1000); // chunk cada segundo para tamaño en tiempo real
  state.isRecording = true;
  state.startTime = Date.now();

  // UI: modo grabando
  btnRecord.classList.add("recording");
  iconMic.classList.add("hidden");
  iconStop.classList.remove("hidden");
  btnRecordLabel.textContent = "Detener";
  timerEl.classList.remove("hidden");
  vizContainer.classList.remove("hidden");
  sizeIndicator.classList.remove("hidden");
  processZone.classList.add("hidden");
  durationWarn.classList.add("hidden");
  pwaHint.classList.add("hidden");

  // Timer
  let elapsed = 0;
  state.timerInterval = setInterval(() => {
    elapsed++;
    timerDisplay.textContent = formatTime(elapsed);

    // Tamaño estimado en tiempo real
    const totalBytes = state.audioChunks.reduce((s, c) => s + c.size, 0);
    sizeIndicator.textContent = `Audio: ${formatBytes(totalBytes)}`;

    // Advertencia de duración
    if (elapsed >= WARNING_MINUTES * 60 && elapsed < MAX_RECORDING_MINUTES * 60) {
      durationWarn.classList.remove("hidden");
    }
    // Detener automáticamente al límite
    if (elapsed >= MAX_RECORDING_MINUTES * 60) {
      showError(`Grabación detenida automáticamente al llegar a ${MAX_RECORDING_MINUTES} minutos.`, 6000);
      stopRecording();
    }
  }, 1000);

  // Visualizador de audio
  setupVisualizer(stream);
}

function stopRecording() {
  if (!state.isRecording || !state.mediaRecorder) return;
  state.mediaRecorder.stop();
  state.mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  state.isRecording = false;

  clearInterval(state.timerInterval);
  cancelAnimationFrame(state.visualizerRAF);
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }
}

function onRecordingStop() {
  // Crear Blob con todos los chunks
  const mimeType = state.mediaRecorder?.mimeType || "audio/webm";
  state.audioBlob = new Blob(state.audioChunks, { type: mimeType });
  state.audioChunks = [];

  // UI: vuelta al estado inicial + mostrar zona de procesar
  btnRecord.classList.remove("recording");
  iconMic.classList.remove("hidden");
  iconStop.classList.add("hidden");
  btnRecordLabel.textContent = "Tocar para grabar";
  vizContainer.classList.add("hidden");
  resetVizBars();

  // Mostrar zona de procesar
  processZone.classList.remove("hidden");
  const totalBytes = state.audioBlob.size;
  sizeIndicator.textContent = `Audio grabado: ${formatBytes(totalBytes)}`;
  sizeIndicator.classList.remove("hidden");
}

function discardRecording() {
  state.audioBlob = null;
  state.audioChunks = [];
  processZone.classList.add("hidden");
  timerEl.classList.add("hidden");
  timerDisplay.textContent = "00:00";
  sizeIndicator.classList.add("hidden");
  durationWarn.classList.add("hidden");
  pwaHint.classList.remove("hidden");
}

// ─── Visualizador de audio ───────────────────────────────────────────────────

function setupVisualizer(stream) {
  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioCtx.createMediaStreamSource(stream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 64;
    source.connect(state.analyser);
    animateViz();
  } catch {
    // Si AudioContext falla (política de autoplay), no es crítico
  }
}

function animateViz() {
  if (!state.analyser) return;
  const bars = document.querySelectorAll(".viz-bar");
  const dataArray = new Uint8Array(state.analyser.frequencyBinCount);

  function draw() {
    state.visualizerRAF = requestAnimationFrame(draw);
    state.analyser.getByteFrequencyData(dataArray);

    bars.forEach((bar, i) => {
      // Mapear los bins de frecuencia a las barras
      const idx = Math.floor((i / bars.length) * dataArray.length);
      const val = dataArray[idx] || 0;
      const heightPx = Math.max(4, Math.round((val / 255) * 44));
      bar.style.height = `${heightPx}px`;
    });
  }
  draw();
}

function resetVizBars() {
  document.querySelectorAll(".viz-bar").forEach((b) => (b.style.height = "4px"));
}

// ─── Llamada al Worker (SSE) ──────────────────────────────────────────────────

async function processAudio() {
  if (!state.audioBlob) {
    showError("No hay audio grabado. Graba primero.");
    return;
  }

  showScreen("processing");
  soapPreviewContainer.classList.add("hidden");
  soapPreview.textContent = "";
  state.transcripcion = "";
  state.notaJson = null;

  const formData = new FormData();
  formData.append("audio", state.audioBlob, "consulta.webm");

  let response;
  try {
    response = await fetch(WORKER_URL, {
      method: "POST",
      body: formData,
    });
  } catch (err) {
    showScreen("record");
    showError("No se pudo conectar al servidor. Verifica tu conexión a internet.");
    return;
  }

  if (!response.ok) {
    let errMsg = "Error en el servidor.";
    try {
      const j = await response.json();
      errMsg = j.error || errMsg;
    } catch {}
    showScreen("record");
    showError(errMsg, 8000);
    return;
  }

  // Consumir el stream SSE
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let soapBuffer = ""; // acumula los tokens del JSON SOAP

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Procesar líneas completas del SSE
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // conservar línea incompleta

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          // La siguiente línea tiene los datos; guardamos el nombre del evento
          continue;
        }
        if (!line.startsWith("data: ")) continue;

        const raw = line.slice(6).trim();
        if (!raw) continue;

        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        // Determinar el tipo de evento buscando la línea "event:" anterior
        const eventLine = lines[lines.indexOf(line) - 1] || "";
        const eventName = eventLine.startsWith("event: ") ? eventLine.slice(7).trim() : "unknown";

        handleSSEEvent(eventName, parsed, soapBuffer, (newBuf) => { soapBuffer = newBuf; });
      }
    }
  } catch (err) {
    showScreen("record");
    showError("Error al recibir la respuesta del servidor. Intenta de nuevo.");
    return;
  }

  // Al terminar el stream, parsear el JSON SOAP completo
  if (soapBuffer) {
    parseAndRenderSoap(soapBuffer.trim());
  }
}

/**
 * Manejador de eventos SSE.
 * Nota: el SSE de fetch no tiene interfaz EventSource limpia cuando viene de fetch(),
 * así que procesamos el buffer manualmente con un approach más robusto.
 */
function processSSEBuffer(rawBuffer) {
  // Reimplementación más robusta: parsear bloques separados por \n\n
  // Se llama con el buffer acumulado completo
}

// Procesamiento: POST simple → JSON response (sin SSE)
async function processAudioV2() {
  if (!state.audioBlob) {
    showError("No hay audio grabado. Graba primero.");
    return;
  }

  showScreen("processing");
  processingStatus.textContent = "Transcribiendo audio...";
  state.transcripcion = "";
  state.notaJson = null;

  const formData = new FormData();
  formData.append("audio", state.audioBlob, "consulta.webm");

  // Cambiar mensaje a mitad del tiempo estimado
  const statusTimer = setTimeout(() => {
    processingStatus.textContent = "Generando nota clínica...";
  }, 6000);

  let data;
  try {
    const response = await fetch(WORKER_URL, { method: "POST", body: formData });
    data = await response.json();
  } catch {
    clearTimeout(statusTimer);
    showScreen("record");
    showError("No se pudo conectar al servidor. Verifica tu conexión a internet.");
    return;
  }

  clearTimeout(statusTimer);

  if (!data.ok) {
    showScreen("record");
    showError(data.error || "Error en el servidor.", 8000);
    return;
  }

  // Guardar transcripción
  state.transcripcion = data.transcripcion || "";
  $("transcripcion-texto").textContent = state.transcripcion;

  // Parsear y mostrar nota SOAP
  parseAndRenderSoap(data.soap || "");
}

// ─── Parseo y renderizado de la nota SOAP ────────────────────────────────────

function tryParseJSON(str) {
  try { return JSON.parse(str.trim()); } catch { return null; }
}

function parseAndRenderSoap(jsonStr) {
  if (!jsonStr || jsonStr.trim().length < 10) {
    showScreen("record");
    showError("No se recibió respuesta del servidor. Intenta de nuevo.");
    return;
  }

  // Intento 1: parseo directo
  let nota = tryParseJSON(jsonStr);

  // Intento 2: quitar markdown fences (```json ... ```)
  if (!nota) {
    const stripped = jsonStr
      .replace(/^[\s\S]*?```(?:json)?\s*/i, "")
      .replace(/\s*```[\s\S]*$/i, "")
      .trim();
    nota = tryParseJSON(stripped);
  }

  // Intento 3: extraer desde la primera { hasta la última }
  if (!nota) {
    const first = jsonStr.indexOf("{");
    const last = jsonStr.lastIndexOf("}");
    if (first !== -1 && last > first) {
      nota = tryParseJSON(jsonStr.slice(first, last + 1));
    }
  }

  if (!nota) {
    showScreen("record");
    showError("La nota generada no tiene formato válido. Intenta de nuevo.");
    console.error("JSON inválido recibido:", jsonStr.slice(0, 300));
    return;
  }

  state.notaJson = nota;
  renderSoap(nota);
  showScreen("result");
}

function setText(id, value) {
  const el = $(id);
  if (!el) return;
  const text = value || "No consignado";
  el.textContent = text;
  if (text === "No consignado") {
    el.classList.add("no-consignado");
  } else {
    el.classList.remove("no-consignado");
  }
}

function renderSoap(nota) {
  const p = nota.paciente || {};
  const s = nota.subjetivo || {};
  const o = nota.objetivo || {};
  const a = nota.analisis || {};
  const pl = nota.plan || {};

  // Paciente
  setText("nota-nombre", p.nombre);
  setText("nota-fecha", nota.fecha_aproximada);
  setText("nota-edad", p.edad ? `${p.edad}` : null);
  setText("nota-sexo", p.sexo);
  setText("nota-acompanante", p.acompanante ? `Acomp: ${p.acompanante}` : null);

  // S
  setText("nota-motivo", s.motivo_consulta);
  setText("nota-padecimiento", s.padecimiento_actual);
  setText("nota-antecedentes", s.antecedentes_relevantes);

  // O
  setText("nota-signos", o.signos_vitales);
  setText("nota-somatometria", o.somatometria);
  setText("nota-exploracion", o.exploracion_fisica);

  // A
  setText("nota-diagnostico", a.impresion_diagnostica);
  setText("nota-diferenciales", a.diagnosticos_diferenciales);

  // P
  setText("nota-tratamiento", pl.tratamiento);
  setText("nota-indicaciones", pl.indicaciones_no_farmacologicas);
  setText("nota-estudios", pl.estudios_solicitados);
  setText("nota-seguimiento", pl.seguimiento);

  // Notas adicionales
  const extra = nota.notas_adicionales;
  const extraSection = $("notas-extra-section");
  if (extra && extra !== "No consignado") {
    $("nota-extra").textContent = extra;
    extraSection.classList.remove("hidden");
  } else {
    extraSection.classList.add("hidden");
  }
}

// ─── Copiar nota al portapapeles ─────────────────────────────────────────────

function buildPlainText(nota) {
  const p = nota.paciente || {};
  const s = nota.subjetivo || {};
  const o = nota.objetivo || {};
  const a = nota.analisis || {};
  const pl = nota.plan || {};
  const nc = (v) => v || "No consignado";

  return `NOTA DE CONSULTA PEDIÁTRICA
Médico: Dr. Yazbek Velazco — Pediatría
Fecha: ${nc(nota.fecha_aproximada)}

PACIENTE
Nombre: ${nc(p.nombre)}
Edad: ${nc(p.edad)} | Sexo: ${nc(p.sexo)}
Acompañante: ${nc(p.acompanante)}

S — SUBJETIVO
Motivo de consulta: ${nc(s.motivo_consulta)}
Padecimiento actual: ${nc(s.padecimiento_actual)}
Antecedentes: ${nc(s.antecedentes_relevantes)}

O — OBJETIVO
Signos vitales: ${nc(o.signos_vitales)}
Somatometría: ${nc(o.somatometria)}
Exploración física: ${nc(o.exploracion_fisica)}

A — ANÁLISIS
Impresión diagnóstica: ${nc(a.impresion_diagnostica)}
Dx diferenciales: ${nc(a.diagnosticos_diferenciales)}

P — PLAN
Tratamiento: ${nc(pl.tratamiento)}
Indicaciones: ${nc(pl.indicaciones_no_farmacologicas)}
Estudios: ${nc(pl.estudios_solicitados)}
Seguimiento: ${nc(pl.seguimiento)}

Notas: ${nc(nota.notas_adicionales)}`;
}

async function copyNota() {
  if (!state.notaJson) return;
  const text = buildPlainText(state.notaJson);

  try {
    await navigator.clipboard.writeText(text);
    // Feedback visual
    btnCopy.classList.add("btn-copied");
    $("btn-copy-label").textContent = "¡Copiado!";
    setTimeout(() => {
      btnCopy.classList.remove("btn-copied");
      $("btn-copy-label").textContent = "Copiar nota";
    }, 2500);
  } catch {
    // Fallback: crear textarea temporal
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    $("btn-copy-label").textContent = "¡Copiado!";
    setTimeout(() => ($("btn-copy-label").textContent = "Copiar nota"), 2500);
  }
}

// ─── Nueva consulta ───────────────────────────────────────────────────────────

function resetApp() {
  state.audioBlob = null;
  state.audioChunks = [];
  state.transcripcion = "";
  state.notaJson = null;
  state.isRecording = false;

  timerDisplay.textContent = "00:00";
  timerEl.classList.add("hidden");
  processZone.classList.add("hidden");
  sizeIndicator.classList.add("hidden");
  durationWarn.classList.add("hidden");
  soapPreview.textContent = "";
  soapPreviewContainer.classList.add("hidden");
  $("transcripcion-texto").textContent = "";
  btnRecord.classList.remove("recording");
  iconMic.classList.remove("hidden");
  iconStop.classList.add("hidden");
  btnRecordLabel.textContent = "Tocar para grabar";
  resetVizBars();

  showScreen("record");
  checkPwaHint();
}

// ─── PWA hint ─────────────────────────────────────────────────────────────────

function checkPwaHint() {
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (!isStandalone) {
    pwaHint.classList.remove("hidden");
  }
}

// ─── Event listeners ─────────────────────────────────────────────────────────

btnRecord.addEventListener("click", () => {
  if (state.isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

btnProcess.addEventListener("click", processAudioV2);
btnDiscard.addEventListener("click", discardRecording);
btnCopy.addEventListener("click", copyNota);
btnNew.addEventListener("click", resetApp);

// Prevenir que el teléfono suspenda la pantalla durante grabación
// (Page Visibility API — pausa el timer si la pestaña se oculta)
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.isRecording) {
    // No detenemos la grabación, MediaRecorder sigue en background en la mayoría de navegadores
    console.log("App en background — la grabación continúa");
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(function init() {
  // Registrar Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Mostrar hint de instalación si no es standalone
  checkPwaHint();

  showScreen("record");
})();
