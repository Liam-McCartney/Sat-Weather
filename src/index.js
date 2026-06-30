// Cloudflare Worker entrypoint: Twilio webhooks in, TwiML responses out.
import { handleMessage } from "./app.js";
import { APP_VERSION } from "./config.js";
import { HydroStore } from "./hydro-store.js";
import { twiml } from "./sms.js";
import { compactAscii } from "./text.js";

export default {
  // Twilio posts form-encoded SMS payloads; GET is reserved for health/admin endpoints.
  async fetch(request, env) {
    if (request.method === "GET") {
      return handleGet(request, env);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const form = await request.formData();
    const message = compactAscii(String(form.get("Body") || ""));
    const from = String(form.get("From") || "").trim();
    const reply = await safeHandleMessage(message, env, from);

    return twiml(reply);
  },
};

// GET endpoints are intentionally admin/health only; SMS commands use POST webhooks.
async function handleGet(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/admin/hydro-sync") {
    return handleHydroSync(url, env);
  }

  if (url.pathname === "/admin/hydro-status") {
    return handleHydroStatus(url, env);
  }

  return new Response(`Sat Weather ${APP_VERSION} is running.`);
}

// Admin endpoint for manually refreshing Hydro station metadata into D1.
async function handleHydroSync(url, env) {
  if (!isAuthorized(url, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const store = new HydroStore(env);
  const result = await store.syncStations();
  return json({
    ok: true,
    stations: result.count,
    updatedAt: result.updatedAt,
  });
}

async function handleHydroStatus(url, env) {
  if (!isAuthorized(url, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const store = new HydroStore(env);
  const count = await store.countStations();
  return json({
    ok: true,
    stations: count,
  });
}

// Simple shared-token auth is enough for private admin endpoints on this tiny bot.
function isAuthorized(url, env) {
  const expected = String(env?.ADMIN_TOKEN || "").trim();
  const provided = String(url.searchParams.get("token") || "").trim();
  return Boolean(expected) && provided === expected;
}

// Never expose stack traces over SMS; keep field failures short and actionable.
async function safeHandleMessage(message, env, from) {
  try {
    return await handleMessage(message, env, from);
  } catch (error) {
    console.error(error);
    return "Error. Try: bot help";
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
