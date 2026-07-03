// index.js — Railway worker (si-v5-worker)
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const WORKER_SECRET = process.env.RAILWAY_WORKER_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/generate", async (req, res) => {
  if (req.headers["x-worker-secret"] !== WORKER_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }

  const { request_id, callback_url, model, resolved_prompt, tools, tool_choice } = req.body || {};
  if (!request_id || !callback_url || !resolved_prompt) {
    return res.status(400).json({ error: "missing request_id, callback_url, or resolved_prompt" });
  }

  res.status(202).json({ accepted: true, request_id });

  const startedAt = Date.now();

  try {
    const anthropicBody = {
      model: model || "claude-sonnet-4-6",
      max_tokens: 4096,
      stream: false,
      messages: [{ role: "user", content: resolved_prompt }],
    };
    if (tools) anthropicBody.tools = tools;
    if (tool_choice) anthropicBody.tool_choice = tool_choice;

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      throw new Error(`Anthropic ${anthropicResp.status}: ${errText.substring(0, 500)}`);
    }

    const data = await anthropicResp.json();

    let script;
    const toolBlock = (data.content || []).find((b) => b.type === "tool_use");
    if (toolBlock) {
      script = toolBlock.input;
    } else {
      const textBlock = (data.content || []).find((b) => b.type === "text");
      script = JSON.parse(textBlock?.text || "{}");
    }

    await fetch(callback_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": WORKER_SECRET,
      },
      body: JSON.stringify({
        request_id,
        success: true,
        script,
        usage: data.usage,
        timing_ms: Date.now() - startedAt,
      }),
    });
  } catch (err) {
    console.error(`[generate] request_id=${request_id} failed:`, err.message);
    try {
      await fetch(callback_url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-secret": WORKER_SECRET,
        },
        body: JSON.stringify({
          request_id,
          success: false,
          error: err.message,
          timing_ms: Date.now() - startedAt,
        }),
      });
    } catch (cbErr) {
      console.error(`[generate] callback failed for request_id=${request_id}:`, cbErr.message);
    }
  }
});
