import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json({ limit: "5mb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WORKER_SECRET = process.env.WORKER_SECRET;
const CALLBACK_URL = process.env.BASE44_CALLBACK_URL; // fallback only

app.get("/", (_req, res) => res.status(200).send("v5 worker alive"));

app.post("/generate", (req, res) => {
  if (req.headers["x-worker-secret"] !== WORKER_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // callback_url is now sent by Base44 in the payload. Prefer it over the env var
  // so we always post back to the correct app domain.
  const { request_id, model, resolved_prompt, output_schema, callback_url } = req.body || {};
  if (!request_id || !resolved_prompt) {
    return res.status(400).json({ error: "missing request_id or resolved_prompt" });
  }

  const callbackUrl = callback_url || CALLBACK_URL;
  if (!callbackUrl) {
    return res.status(400).json({ error: "no callback_url provided and BASE44_CALLBACK_URL not set" });
  }

  res.status(202).json({ accepted: true, request_id });

  synthesizeAndCallback({ request_id, model, resolved_prompt, output_schema, callbackUrl })
    .catch((err) => {
      console.error(`[${request_id}] synthesis failed:`, err.message);
      postCallback(callbackUrl, { request_id, success: false, error: err.message });
    });
});

async function synthesizeAndCallback({ request_id, model, resolved_prompt, output_schema, callbackUrl }) {
  const started = Date.now();

  const message = await anthropic.messages.create({
    model: model || "claude-opus-4-20250514",
    max_tokens: 4096,
    tools: [{
      name: "emit_coaching_message",
      description: "Return the structured daily coaching message.",
      input_schema: output_schema || { type: "object", properties: {}, additionalProperties: true }
    }],
    tool_choice: { type: "tool", name: "emit_coaching_message" },
    messages: [{ role: "user", content: resolved_prompt }]
  });

  const toolUse = message.content.find((c) => c.type === "tool_use");
  if (!toolUse) throw new Error("No tool_use block in Anthropic response");

  await postCallback(callbackUrl, {
    request_id,
    success: true,
    script: toolUse.input,
    usage: message.usage,
    timing_ms: Date.now() - started
  });
}

async function postCallback(callbackUrl, payload) {
  const resp = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-secret": WORKER_SECRET
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[${payload.request_id}] callback rejected ${resp.status}: ${body}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`v5 worker listening on ${PORT}`));
