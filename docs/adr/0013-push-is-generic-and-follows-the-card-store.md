# Push is generic and follows the Card store

A push is sent when the Card store reports a newly made Card that is waiting, to the devices of each Member who must act on it (ADR 0008, ADR 0010). Tools do not know push exists. The store announces a Card only when it is first made, so a rerun after a crash (`create` with the same id) and a restart send nothing again. A push is not retried: if a service is down the Card still shows in the app as a badge, which is the source of truth.

The payload is always the same: title "Hamkey", body "A Bot needs you", URL "/". It names no Bot, since a Personal Bot's name can be private, and quotes no fact, question or option. The text is also encrypted (RFC 8291) by the `web-push` package, but the push service still learns that a push happened, so the text says nothing more than that.

Subscriptions are kept per Member in `<dataDir>/push.json`, and a device (endpoint) belongs to one Member at a time. The endpoint must be an https address with a public host name, because the server connects to it. A subscription the push service rejects with 404 or 410 is removed. The VAPID key pair is made once into `<dataDir>/vapid.json` (mode 600) and is never in the repository or logs.

`web-push` 3.6.7 (2024) is used instead of hand-written encryption: it implements RFC 8291 and RFC 8292 and is widely used. 4.0.0 is only days old. The sender sits behind `PushSender`, and tests use a recording fake.
