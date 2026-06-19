import { handleMessage } from "./app.js";
import { APP_VERSION } from "./config.js";
import { twiml } from "./sms.js";

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response(`Sat Weather ${APP_VERSION} is running.`);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const form = await request.formData();
    const message = String(form.get("Body") || "").trim();
    const from = String(form.get("From") || "").trim();
    const reply = await safeHandleMessage(message, env, from);

    return twiml(reply);
  },
};

async function safeHandleMessage(message, env, from) {
  try {
    return await handleMessage(message, env, from);
  } catch (error) {
    console.error(error);
    return "Error. Try: wx help";
  }
}
