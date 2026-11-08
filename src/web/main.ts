import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app")! });

// The service worker only shows pushes; it caches nothing. Development has no built worker to serve.
if ("serviceWorker" in navigator && !import.meta.env.DEV) navigator.serviceWorker.register("/sw.js").catch(() => {});
