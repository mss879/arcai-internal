// ARC AI service worker — handles background web-push notifications.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "ARC AI", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "ARC AI";
  const options = {
    body: data.body || "",
    icon: "/new-logo.png",
    badge: "/new-logo.png",
    data: { link: data.link || "/" },
    // Vibrate on supported mobile devices.
    vibrate: [80, 40, 80],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an already-open tab and navigate it to the link.
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(link);
            } catch (e) {
              /* cross-origin or unsupported — ignore */
            }
          }
          return;
        }
      }
      // Otherwise open a fresh window.
      if (self.clients.openWindow) await self.clients.openWindow(link);
    })(),
  );
});
