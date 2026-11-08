// Hamkey's service worker. It does two things only: show a push, and open the app when the push is tapped.
// It caches nothing, so the app and every API answer always come from the server.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {}
	// One notification at a time is enough: "a Bot needs you" is the same whichever Card it is.
	event.waitUntil(
		self.registration.showNotification(typeof data.title === "string" ? data.title : "Hamkey", {
			body: typeof data.body === "string" ? data.body : "A Bot needs you",
			icon: "/icon-192.png",
			tag: "hamkey-needs-you",
			data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = event.notification.data?.url ?? "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
			const open = windows[0];
			return open ? open.focus() : self.clients.openWindow(url);
		}),
	);
});
