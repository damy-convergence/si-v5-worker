// index.js — Railway worker (si-v5-worker)
// Receives a dispatch from Base44, runs Anthropic synthesis (non-streaming),
// and POSTs the result back to the callback_url Base44 provided.
import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const WORKER_SECRET = process.env.RAILWAY_WORKER_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.get("/health", (_req, res) => res.json({ ok: true }));

// Strip markdown code fences (```json ... ``` or ``` ... ```) that Anthropic
// often wraps around JSON in plain-text blocks, then parse. Falls back to
// extracting the first {...} object if the whole string still won't parse.
function parseScript(rawText) {
  let text = (rawText || "").trim();

  // Remove leading/trailing markdown fences.
  if (text.startsWith("```")) {
    text = text
      .replace(/^```(?:json)?\s*/i, "") // opening fence, optional "json"
      .replace(/```\s*$/i, "")          // closing fence
      .trim();
  }

  try {
    return JSON.parse(text);
  } catch (_e) {
    // Last resort: grab the first balanced-looking JSON object.
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(text.substring(firstBrace, lastBrace + 1));
    }
    throw new Error(
      `Could not parse Anthropic text as JSON: ${text.substring(0, 200)}`
    );
  }
}

app.post("/generate", async (req, res) => {
  // 1. Authenticate the incoming dispatch from Base44.
  if (req.headers["x-worker-secret"] !== WORKER_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }

  const { request_id, callback_url, model, resolved_prompt, tools, tool_choice } = req.body || {};
  if (!request_id || !callback_url || !resolved_prompt) {
    return res.status(400).json({ error: "missing request_id, callback_url, or resolved_prompt" });
  }

  // 2. ACK immediately so Base44 doesn't wait (fire-and-forget async pattern).
  res.status(202).json({ accepted: true, request_id });

  const startedAt = Date.now();

  // 3. Do the heavy work AFTER responding.
  try {
    const anthropicBody = {
      model: model || "claude-sonnet-4-6",
      max_tokens: 4096,
      stream: false, // ← NON-STREAMING: single JSON response, no SSE parsing
      messages: [{ role: "user", content: resolved_prompt }],
    };
    // If Base44 sent a forced-tool JSON schema, pass it through.
    if (tools) anthropicBody.tools = tools;
    if (tool_choice) anthropicBody.tool_choice = tool_choice;

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01", // ← required version header
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      throw new Error(`Anthropic ${anthropicResp.status}: ${errText.substring(0, 500)}`);
    }

    const data = await anthropicResp.json(); // ← read once, not a stream

    // 4. Extract the script. Tool-forced output lands in a tool_use block;
    // plain text lands in a text block (which may be wrapped in markdown fences).
    let script;
    const toolBlock = (data.content || []).find((b) => b.type === "tool_use");
    if (toolBlock) {
      script = toolBlock.input; // already a parsed object
    } else {
      const textBlock = (data.content || []).find((b) => b.type === "text");
      script = parseScript(textBlock?.text || "{}");
    }

    // 5. Callback to Base44 — WITH the shared secret header.
    await fetch(callback_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": WORKER_SECRET, // ← REQUIRED so receiveRailwayScript accepts it
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
    // 6. On failure, still call back so the request doesn't stay stuck in "processing".
    console.error(`[generate] request_id=${request_id} failed:`, err.message);
    try {
      await fetch(callback_url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-secret": WORKER_SECRET, // ← secret header on failure callback too
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`si-v5-worker listening on ${PORT}`));
