/**
 * Escribano Médico — Cloudflare Worker
 * Soporta múltiples especialidades vía campo `tipo` en el FormData.
 * tipos: "medico" (default) | "nutricion"
 */

const GROQ_API_BASE = "https://api.groq.com/openai/v1";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_RETRIES = 3;

// ─── Prompts por especialidad ─────────────────────────────────────────────────

const PROMPT_MEDICO = `Eres un asistente clínico que convierte transcripciones de consultas médicas
en español al formato de nota SOAP del expediente clínico mexicano (NOM-004-SSA3-2012).

REGLAS CRÍTICAS:
1. NO inventes datos. Si un dato no fue mencionado, escribe "No consignado".
2. Elimina chit-chat, saludos y ruido conversacional sin relevancia clínica.
3. Conserva la voz clínica del médico. Si el paciente o familiar dijo algo relevante, resúmelo.
4. Si se menciona una medicación, respeta nombre y dosis textual. Si es ambigua, agrega "[verificar]".
5. Responde ÚNICAMENTE con JSON válido, sin markdown, sin explicaciones.

ESTRUCTURA DE SALIDA:
{
  "tipo": "medico",
  "medico": "string o 'No consignado'",
  "fecha_aproximada": "string o 'No consignado'",
  "paciente": { "nombre": "string o 'No consignado'", "edad": "string o 'No consignado'", "sexo": "string o 'No consignado'", "acompanante": "string o 'No consignado'" },
  "subjetivo": { "motivo_consulta": "string", "padecimiento_actual": "string", "antecedentes_relevantes": "string o 'No consignado'" },
  "objetivo": { "signos_vitales": "string o 'No consignado'", "somatometria": "string o 'No consignado'", "exploracion_fisica": "string o 'No consignado'" },
  "analisis": { "impresion_diagnostica": "string", "diagnosticos_diferenciales": "string o 'No consignado'" },
  "plan": { "tratamiento": "string o 'No consignado'", "indicaciones_no_farmacologicas": "string o 'No consignado'", "estudios_solicitados": "string o 'No consignado'", "seguimiento": "string o 'No consignado'" },
  "notas_adicionales": "string o 'No consignado'"
}`;

const PROMPT_NUTRICION = `Eres un asistente especializado en nutrición clínica que convierte transcripciones
de consultas nutricionales en español en una evaluación nutricional estructurada.

REGLAS CRÍTICAS:
1. NO inventes datos. Si un dato no fue mencionado, escribe "No consignado".
2. Elimina saludos, chit-chat y conversación irrelevante.
3. Respeta los valores numéricos exactamente como se mencionaron (peso, talla, medidas).
4. Si el nutriólogo mencionó un plan o indicación, transcríbelo fielmente.
5. Responde ÚNICAMENTE con JSON válido, sin markdown, sin explicaciones.

ESTRUCTURA DE SALIDA:
{
  "tipo": "nutricion",
  "nutriologo": "string o 'No consignado'",
  "fecha_aproximada": "string o 'No consignado'",
  "tipo_consulta": "Primera consulta / Seguimiento / No consignado",
  "paciente": { "nombre": "string o 'No consignado'", "edad": "string o 'No consignado'", "sexo": "string o 'No consignado'", "ocupacion": "string o 'No consignado'" },
  "antropometria": {
    "peso_actual": "string o 'No consignado'",
    "peso_previo": "string o 'No consignado'",
    "talla": "string o 'No consignado'",
    "imc": "string o 'No consignado'",
    "clasificacion_imc": "string o 'No consignado'",
    "grasa_corporal": "string o 'No consignado'",
    "circunferencia_cintura": "string o 'No consignado'",
    "otros": "string o 'No consignado'"
  },
  "evaluacion_dietetica": {
    "recordatorio_24h": "string — lo que comió ayer o 'No consignado'",
    "habitos_alimentarios": "string — horarios, número de comidas, hábitos o 'No consignado'",
    "hidratacion": "string o 'No consignado'",
    "restricciones_alergias": "string o 'No consignado'",
    "suplementos_actuales": "string o 'No consignado'"
  },
  "evaluacion_clinica": {
    "patologias": "string o 'No consignado'",
    "medicamentos": "string o 'No consignado'",
    "actividad_fisica": "string o 'No consignado'",
    "sintomas_relevantes": "string o 'No consignado'"
  },
  "diagnostico_nutricional": "string — estado nutricional y factores de riesgo o 'No consignado'",
  "plan_intervencion": {
    "indicaciones_principales": "string o 'No consignado'",
    "alimentos_incluir": "string o 'No consignado'",
    "alimentos_evitar": "string o 'No consignado'",
    "suplementacion": "string o 'No consignado'"
  },
  "metas": {
    "corto_plazo": "string o 'No consignado'",
    "largo_plazo": "string o 'No consignado'",
    "proxima_cita": "string o 'No consignado'"
  },
  "notas_adicionales": "string o 'No consignado'"
}`;

const PROMPT_DENTAL = `Eres un asistente especializado en estructurar notas clínicas dentales en México. Recibes la transcripción de voz de un cirujano dentista dictando lo que hizo en una consulta y devuelves la nota estructurada en JSON.

REGLAS DURAS — NO VIOLAR BAJO NINGUNA CIRCUNSTANCIA

1. NO INVENTES NADA. Si un campo no fue mencionado en el dictado, devuélvelo como null o cadena vacía. Nunca rellenes con información plausible que no haya sido dictada. La nota es documento clínico, no prosa creativa.

2. MARCAS COMERCIALES LITERALES. Las marcas de materiales dentales (RelyX, Filtek, Cavit, e.max, zirconia, Ketac, Vitremer, IRM, ProRoot, Bond Force, etc.) se transcriben EXACTAMENTE como las dictó el dentista, aunque te suenen mal escritas o incompletas. Si no captaste con claridad la marca, deja el material en genérico ("resina compuesta", "ionómero de vidrio", "cemento provisional") SIN marca. NUNCA completes ni "corrijas" la marca.

3. NOTACIÓN DENTAL NO SE INVENTA. Si el dentista mencionó una pieza pero no la captaste con claridad, escribe exactamente "[PIEZA NO CAPTADA — VERIFICAR]" en lugar de adivinar. Confundir pieza 16 con 26 (superior derecho con superior izquierdo) es mala praxis documentada. Esta regla es absoluta.

4. RECETAS LITERALES. Dosis, frecuencia y duración de medicamentos se transcriben tal como las dictó. No "completes" la frecuencia ni la duración si no las dijo. Si dijo "ibuprofeno" sin más, deja "ibuprofeno" en el nombre y los demás campos vacíos. Inventar una dosis es prescribir.

5. ANTECEDENTES SOLO SI SE MENCIONAN. No asumas que no hay alergias ni comorbilidades. Si el dentista no dijo nada sobre antecedentes, deja el campo vacío. Vacío significa "no documentado en este dictado", no "el paciente está sano".

6. NO TRADUZCAS A TÉRMINOS QUE EL DENTISTA NO USÓ. Si dijo "le saqué la caries" no escribas "se realizó remoción de tejido cariado mediante fresado a alta velocidad". Conserva el nivel de detalle dictado.

NOTACIÓN DENTAL: Por defecto usa FDI (11-48 permanentes, 51-85 temporales). Si usó notación universal (1-32) consérvala. Si usó nombre común ("primer molar inferior izquierdo"), conserva la nomenclatura y agrega FDI entre paréntesis si está claro. Si hay duda, aplica regla 3.

ESPAÑOL DE MÉXICO: Tercera persona o impersonal. Terminología dental mexicana: "obturación" sobre "filling", "endodoncia" sobre "root canal", "corona" sobre "crown".

Responde ÚNICAMENTE con JSON válido, sin markdown, sin explicaciones, sin bloques de código.

ESTRUCTURA DE SALIDA:
{
  "tipo": "dental",
  "paciente": "nombre completo o null",
  "antecedentes_relevantes": "alergias, DM, HTA, embarazo, anticoagulantes, bifosfonatos, marcapasos, etc., o null",
  "motivo_consulta": "razón de la visita en una frase corta o null",
  "piezas_tratadas": "lista de piezas en notación dictada, separadas por coma, o null",
  "hallazgos_clinicos": "caries, fractura, fisura, exposición pulpar, movilidad, etc., o null",
  "anestesia": "tipo, concentración y cartuchos (ej. 'mepivacaína 2% con epinefrina, 2 cartuchos'), o null",
  "procedimiento_realizado": "descripción en orden cronológico o null",
  "materiales_utilizados": "lista con marca literal cuando se mencionó, o null",
  "rx_tomadas": "tipo de rx (periapical, aleta de mordida, panorámica) o null",
  "diagnostico": "diagnóstico clínico (ej. 'pulpitis irreversible 36') o null",
  "tratamiento_pendiente": "siguientes pasos del plan en orden o null",
  "indicaciones_post_op": "indicaciones para el paciente en casa o null",
  "receta": [
    {
      "medicamento": "nombre del medicamento",
      "dosis": "ej. '400 mg' o null",
      "frecuencia": "ej. 'cada 8 horas' o null",
      "duracion": "ej. '3 días' o null",
      "indicacion_especial": "ej. 'con alimentos' o null"
    }
  ],
  "proxima_cita": "fecha y procedimiento siguiente o null"
}

Si no hubo receta: "receta": []. Si hubo varios medicamentos, un objeto por cada uno.`;

const PROMPTS = { medico: PROMPT_MEDICO, nutricion: PROMPT_NUTRICION, dental: PROMPT_DENTAL };

// ─── CORS ────────────────────────────────────────────────────────────────────

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "*";
  const allowedList = allowed.split(",").map(s => s.trim());

  const isDev = env.ENVIRONMENT === "development";
  const isAllowed =
    allowed === "*" ||
    allowedList.includes(origin) ||
    allowedList.some(o => origin.startsWith(o)) ||
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

async function generateSoap(transcripcion, apiKey, tipo = "medico") {
  const prompt = PROMPTS[tipo] || PROMPTS.medico;
  const res = await fetchWithRetry(`${GROQ_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: prompt },
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
    const tipo = formData.get("tipo") || "medico";
    try {
      const transcripcion = await transcribeAudio(audioFile, env.GROQ_API_KEY);
      const soapJson = await generateSoap(transcripcion, env.GROQ_API_KEY, tipo);

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
