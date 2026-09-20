self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  var kind = data.kind || "kick";
  var sound = data.sound || (kind === "yes" ? "/sounds/yes.wav" : kind === "no" ? "/sounds/no.wav" : "/sounds/kick.wav");
  var title = data.title || "Vantage";
  var opts = {
    body: data.body || "",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: data.tag || title,
    renotify: true,
    silent: false,
    vibrate: kind === "yes" ? [80, 40, 80, 40, 160] : kind === "no" ? [240, 80, 240] : [100, 50, 100],
    sound: sound,
    data: { url: data.url || "/book", kind: kind, sound: sound }
  };
  e.waitUntil(
    self.registration.showNotification(title, opts).then(function () {
      return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cs) {
        cs.forEach(function (c) { c.postMessage({ type: "vfs-sound", kind: kind, sound: sound }); });
      });
    })
  );
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "/book";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (wins) {
    for (var i = 0; i < wins.length; i++) {
      if (wins[i].url && "focus" in wins[i]) return wins[i].focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
