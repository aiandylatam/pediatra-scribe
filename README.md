# Escribano del Pediatra

Graba una consulta pediátrica → recibe la nota SOAP lista para copiar.

> **Esta app NO almacena audio ni notas. Todo se borra al cerrar la pestaña.**

---

## ¿Qué hace?

1. El doctor abre la URL en su celular y toca "Grabar".
2. Atiende la consulta normalmente (hasta ~20 minutos).
3. Toca "Detener y procesar".
4. En 15–30 segundos recibe la nota SOAP estructurada según NOM-004-SSA3-2012.
5. Toca "Copiar nota" y pega en su sistema de expediente.

---

## Arquitectura

```
[Celular] → MediaRecorder (opus 16kbps mono)
         → POST audio → [Cloudflare Worker]
                            → Groq Whisper (transcripción)
                            → Groq Llama 3.3 70B (nota SOAP)
                        ← SSE con nota en streaming
[Celular] ← muestra nota SOAP formateada
```

**La clave de Groq vive solo en el Worker. El frontend nunca la ve.**

---

## Requisitos antes de desplegar

| Recurso | URL | Costo |
|---|---|---|
| Cuenta Groq | https://console.groq.com | Gratis |
| Cuenta Cloudflare | https://cloudflare.com | Gratis |
| Cuenta GitHub | https://github.com | Gratis |
| Node.js ≥ 18 | https://nodejs.org | Gratis |

---

## Despliegue paso a paso

### 1. Preparar el Worker

```bash
# Instalar Wrangler (CLI de Cloudflare Workers)
npm install -g wrangler

# Entrar a la carpeta del worker
cd worker/

# Autenticarse en Cloudflare (abre el navegador)
wrangler login

# Agregar la API key de Groq como secret (no va en el código)
wrangler secret put GROQ_API_KEY
# → Pega tu key gsk_xxxx cuando lo pida

# Probar en local (opcional)
wrangler dev
# → Abre http://localhost:8787 para probar con curl
```

### 2. Desplegar el Worker

```bash
# Desde la carpeta worker/
wrangler deploy
```

Copia la URL que aparece, se ve así:
```
https://pediatra-scribe-api.TU-SUBDOMINIO.workers.dev
```

### 3. Generar los iconos PWA

Abre en tu navegador: `frontend/icons/generate-icons.html`

Descarga `icon-192.png` y `icon-512.png` y guárdalos en `frontend/icons/`.

### 4. Actualizar la URL del Worker en el frontend

Edita `frontend/app.js`, línea 10:

```js
const WORKER_URL = "https://pediatra-scribe-api.TU-SUBDOMINIO.workers.dev";
```

### 5. Desplegar en GitHub Pages

```bash
# Desde la raíz del proyecto
git init
git add .
git commit -m "feat: pediatra scribe inicial"

# Crear repo en GitHub (sin inicializar)
# En GitHub.com: New repository → "pediatra-scribe" → Create

git remote add origin https://github.com/TU-USUARIO/pediatra-scribe.git
git branch -M main
git push -u origin main
```

En GitHub:
1. **Settings** → **Pages**
2. Source: `Deploy from a branch`
3. Branch: `main` / Folder: `/frontend`
4. Guardar → esperar 1–2 minutos

Tu URL será: `https://aiandylatam.github.io/pediatra-scribe/`

### 6. Configurar CORS en el Worker

Edita `worker/wrangler.toml`:

```toml
[vars]
ENVIRONMENT = "production"
ALLOWED_ORIGIN = "https://TU-USUARIO.github.io"
```

Y redesplega:

```bash
cd worker/
wrangler deploy
```

---

## Rotar la API key de Groq

```bash
cd worker/
wrangler secret put GROQ_API_KEY
# → Pega la nueva key
wrangler deploy
```

No es necesario tocar el frontend.

---

## Cómo dar acceso al doctor

Solo manda la URL de GitHub Pages:
```
https://TU-USUARIO.github.io/pediatra-scribe/
```

No hay login, no hay registro. El doctor la abre en su celular y la instala como app.

---

## Límites conocidos

| Límite | Valor | Impacto |
|---|---|---|
| Duración máxima de grabación | ~20 min (la app detiene automáticamente) | Consultas >20 min deben dividirse |
| Tamaño máximo de audio | 25 MB (límite Groq Whisper) | A 16kbps mono, equivale a ~210 min — sin problema real |
| Rate limit Groq Whisper | 20 req/min, 2000 req/día | Para uso individual de un médico, nunca se alcanza |
| Rate limit Groq Llama | 30 req/min | Sin problema para uso individual |
| Safari iOS | Usa MP4 en lugar de WebM | Funciona pero genera archivos ligeramente más grandes |

---

## Privacidad y aviso legal

- El audio y la nota **no se almacenan** en ningún servidor de esta app.
- El audio se procesa por **Groq** (ver [política de privacidad de Groq](https://groq.com/privacy-policy/)). Groq no retiene datos de la API por defecto.
- Esta app es una **herramienta de apoyo**, no un sistema de expediente clínico certificado.
- No es HIPAA-compliant. Para uso en contextos que lo requieran, evalúa las implicaciones regulatorias aplicables.
- Cumplimiento con LFPDPPP México: al no haber base de datos ni transmisión de datos a servidores propios, el riesgo de tratamiento de datos personales es mínimo. El médico es responsable del uso que haga de las notas generadas.

---

## Solución de problemas

**El Worker devuelve error 500**
→ Verifica que `GROQ_API_KEY` está configurado: `wrangler secret list`

**CORS error en el navegador**
→ Verifica que `ALLOWED_ORIGIN` en `wrangler.toml` coincide exactamente con la URL de GitHub Pages (sin slash al final)

**"No se detectó voz en el audio"**
→ El micrófono del celular puede necesitar estar a menos de 50 cm del médico. Verifica que el micrófono no esté tapado.

**Safari iOS no graba**
→ Funciona, pero usa MP4. Si hay problemas, actualizar Safari a la versión más reciente.

**La nota tiene campos "No consignado" que sí se mencionaron**
→ El modelo de IA solo extrae lo que escuchó claramente. Hablar más cerca del micrófono mejora la precisión.

---

## Estructura del proyecto

```
pediatra-scribe/
├── README.md
├── frontend/
│   ├── index.html          ← app completa (una sola página)
│   ├── app.js              ← grabación + SSE + renderizado
│   ├── styles.css          ← estilos complementarios
│   ├── manifest.json       ← configuración PWA
│   ├── sw.js               ← service worker (instalabilidad)
│   └── icons/
│       ├── icon-192.png
│       ├── icon-512.png
│       └── generate-icons.html  ← generador de iconos
└── worker/
    ├── worker.js           ← pipeline Groq (Whisper + Llama)
    └── wrangler.toml       ← configuración de deploy
```
