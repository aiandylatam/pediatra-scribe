/**
 * Pediatra Scribe — Service Worker mínimo
 * Estrategia: Cache-first para el shell de la app (offline-ready).
 *             Network-only para llamadas al Worker de Cloudflare.
 */

const CACHE_NAME = "pediatra-scribe-v1";

// Assets del shell que se cachean en la instalación
const SHELL_ASSETS = [
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// ─── Instalación: pre-cachear el shell ───────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll falla si algún asset no está disponible; ignoramos el error
      // para no bloquear la instalación si los iconos aún no existen
      return cache.addAll(SHELL_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// ─── Activación: limpiar caches viejos ───────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch: cache-first para shell, network-only para APIs ───────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Llamadas al Worker de Cloudflare → siempre red (nunca cachear audio/notas)
  if (
    url.hostname.endsWith("workers.dev") ||
    url.hostname.endsWith("groq.com")
  ) {
    // Network-only: no interceptar, dejar pasar
    return;
  }

  // Recursos CDN externos (Tailwind, etc.) → network-first
  if (!url.hostname.includes("github.io") && url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Shell de la app → cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Guardar en caché si es una respuesta válida
        if (response && response.status === 200 && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
