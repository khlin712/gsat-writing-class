const CACHE_PREFIX = "gsat-pdf-scanner";

self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX)).map(key => caches.delete(key)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: "window" });
    for (const client of windows) {
      try { await client.navigate(client.url); } catch (_) {}
    }
  })());
});
