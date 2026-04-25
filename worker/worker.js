/**
 * Escribano del Pediatra — Cloudflare Worker
 * Pipeline: audio → Groq Whisper (transcripción) → Groq Llama 3.3 70B (nota SOAP)
 * Responde con SSE para streaming de la nota al frontend.
 */

const GROQ_API_BASE = "https://api.groq.com/openai/v1";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB — límite de Groq Whisper
const MAX_RETRIES = 3;

// ─── Prompt clínico ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un asistente clínico que convierte transcripciones de consultas pediátricas
en español al formato de nota SOAP del expediente clínico mexicano (NOM-004-SSA3-2012).

REGLAS CRÍTICAS:
1. NO inventes datos. Si un dato no fue mencionado en la transcripción, escribe
   exactamente "No consignado" en ese campo. Nunca infieras valores de signos
   vitales, medicamentos, dosis, diagnósticos o fechas.
2. Elimina chit-chat, saludos, interrupciones del niño, comentarios del cuidador
   sin relevancia clínica, y ruido conversacional.
3. Conserva la voz clínica del médico; si el cuidador dijo algo relevante,
   resúmelo como "la madre refiere que..." o "el padre menciona...".
4. Si se menciona una medicación, respeta el nombre y dosis textual. Si la dosis
   suena ambigua, déjala textual entre comillas y agrega "[verificar]".
5. Responde ÚNICAMENTE con JSON válido, sin markdown, sin explicaciones, sin bloques de código.

ESTRUCTURA DE SALIDA OBLIGATORIA:
{
  "medico": "Médico tratante — si se mencionó nombre y especialidad, anótalos; si no, escribe 'No consignado'",
  "fecha_aproximada": "string — fecha si se mencionó, si no 'No consignado'",
  "paciente": {
    "nombre": "string o 'No consignado'",
    "edad": "string o 'No consignado'",
    "sexo": "string o 'No consignado'",
    "acompanante": "string o 'No consignado'"
  },
  "subjetivo": {
    "motivo_consulta": "string — en una frase",
    "padecimiento_actual": "string — narrativa clínica, sin chit-chat",
    "antecedentes_relevantes": "string — solo lo mencionado en la consulta"
  },
  "objetivo": {
    "signos_vitales": "string o 'No consignado'",
    "somatometria": "string o 'No consignado'",
    "exploracion_fisica": "string — solo hallazgos mencionados por el médico"
  },
  "analisis": {
    "impresion_diagnostica": "string — lo que el médico dictó o dedujo en voz alta",
    "diagnosticos_diferenciales": "string o 'No consignado'"
  },
  "plan": {
    "tratamiento": "string — medicamentos, dosis, duración tal como se mencionaron",
    "indicaciones_no_farmacologicas": "string o 'No consignado'",
    "estudios_solicitados": "string o 'No consignado'",
    "seguimiento": "string — próxima cita o signos de alarma mencionados"
  },
  "notas_adicionales": "string — cualquier información clínica relevante que no encaje arriba, o 'No consignado'"
}`;

// ─── CORS ────────────────────────────────────────────────────────────────────

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "*";

  // En desarrollo se permite localhost
  const isDev = env.ENVIRONMENT === "development";
  const isAllowed =
    allowed === "*" ||
    origin === allowed ||
    (isDev && origin.startsWith("http://localhost"));

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin || "*" : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function handleOptions(env, request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env, request),
  });
}

// ─── Retry con backoff ───────────────────────────────────────────────────────

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    lastError = res;
    // Backoff: 1s, 2s, 4s
    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)));
  }
  return lastError;
}

// ─── Transcripción con Whisper ───────────────────────────────────────────────

async function transcribeAudio(audioBlob, apiKey) {
  const form = new FormData();
  form.append("file", audioBlob, "consulta.webm");
  form.append("model", "whisper-large-v3");
  form.append("language", "es");
  form.append("response_format", "text");

  const res = await fetchWithRetry(`${GROQ_API_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Error desconocido");
    if (res.status === 429) {
      throw new Error("RATE_LIMIT: Servicio de transcripción saturado. Intenta en 1 minuto.");
    }
    throw new Error(`WHISPER_ERROR: ${res.status} — ${errText}`);
  }

  const transcripcion = await res.text();
  if (!transcripcion || transcripcion.trim().length < 10) {
    throw new Error("EMPTY_TRANSCRIPTION: El audio no tiene voz audible o fue demasiado corto.");
  }
  return transcripcion.trim();
}

// ─── Generación SOAP con Llama (respuesta completa, no streaming) ────────────

async function generateSoap(transcripcion, apiKey) {
  const res = await fetchWithRetry(`${GROQ_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Transcripción de la consulta:\n\n${transcripcion}`,
        },
      ],
      stream: false,
      temperature: 0.1,
      max_tokens: 2048,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Error desconocido");
    if (res.status === 429) {
      throw new Error("RATE_LIMIT: Servicio de generación de notas saturado. Intenta en 1 minuto.");
    }
    throw new Error(`LLAMA_ERROR: ${res.status} — ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLAMA_ERROR: Respuesta vacía del modelo.");
  return content;
}

// ─── Handler principal ───────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // Preflight CORS
    if (request.method === "OPTIONS") {
      return handleOptions(env, request);
    }

    // Solo POST
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Método no permitido" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
      });
    }

    // Verificar API key configurada
    if (!env.GROQ_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Configuración incompleta: falta GROQ_API_KEY en el Worker." }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
        }
      );
    }

    // Leer FormData con el audio
    let formData;
    try {
      formData = await request.formData();
    } catch {
      return new Response(JSON.stringify({ error: "El cuerpo de la petición debe ser multipart/form-data." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
      });
    }

    const audioFile = formData.get("audio");
    if (!audioFile || typeof audioFile === "string") {
      return new Response(JSON.stringify({ error: "Falta el campo 'audio' en el formulario." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
      });
    }

    // Validar tamaño
    if (audioFile.size > MAX_AUDIO_BYTES) {
      const mb = (audioFile.size / 1024 / 1024).toFixed(1);
      return new Response(
        JSON.stringify({
          error: `El audio pesa ${mb} MB y supera el límite de 25 MB. Graba segmentos más cortos.`,
        }),
        {
          status: 413,
          headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
        }
      );
    }

    // ── Pipeline: Whisper → Llama → JSON response ────────────────────────────
    try {
      const transcripcion = await transcribeAudio(audioFile, env.GROQ_API_KEY);
      const soapJson = await generateSoap(transcripcion, env.GROQ_API_KEY);

      return new Response(
        JSON.stringify({ ok: true, transcripcion, soap: soapJson }),
        { headers: { "Content-Type": "application/json", ...corsHeaders(env, request) } }
      );
    } catch (err) {
      const msg = err.message || "Error interno del servidor.";
      const legible = msg.startsWith("RATE_LIMIT:")
        ? msg.replace("RATE_LIMIT:", "").trim()
        : msg.startsWith("EMPTY_TRANSCRIPTION:")
        ? "No se detectó voz en el audio. Verifica que el micrófono esté cerca y vuelve a intentar."
        : "Ocurrió un error al procesar la consulta. Intenta de nuevo.";

      return new Response(
        JSON.stringify({ ok: false, error: legible }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(env, request) } }
      );
    }
  },
};
