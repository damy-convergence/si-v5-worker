// si-v5-worker — SalesIndex V5 message synthesis worker
// =====================================================
// Contract with Base44:
//   1. Base44 (modules/v5MessageEngine) POSTs /generate with:
//        { request_id, model, resolved_prompt, output_schema, callback_url }
//   2. This worker ACKs 202 { accepted: true } INSTANTLY, then does the slow
//      Anthropic synthesis in the background.
//   3. When synthesis finishes, it POSTs the result back to `callback_url`
//      (Base44's receiveRailwayScript) with the x-worker-secret header.
//
// LOOP-PREVENTION RULES:
//   • Anthropic is called EXACTLY ONCE per job. On synthesis failure we report
//     failure to Base44 and STOP — we never re-run the Opus generation.
//   • Only the cheap callback POST is retried (max 3, with backoff), and it
//     reuses the already-generated script. No second Anthropic call, ever.
//   • The callback target is ALWAYS the `callback_url` from the dispatch payload
//     (falls back to BASE44_CALLBACK_URL only if the payload omits it).

import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 80;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Accept either name so a mis-named env var can't silently break auth.
const WORKER_SECRET = process.env.WORKER_SECRET || process.env.RAILWAY_WORKER_SECRET;
const FALLBACK_CALLBACK_URL = process.env.BASE44_CALLBACK_URL || '';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

// ── health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.status(200).json({
        ok: true,
        service: 'si-v5-worker',
        has_anthropic_key: !!ANTHROPIC_API_KEY,
        has_worker_secret: !!WORKER_SECRET,
        has_fallback_callback: !!FALLBACK_CALLBACK_URL,
        time: new Date().toISOString(),
    });
});

// ── auth guard ────────────────────────────────────────────────────────────────
function isAuthorized(req) {
    const provided = req.get('x-worker-secret');
    return !!WORKER_SECRET && provided === WORKER_SECRET;
}

// ── strip markdown code fences the model sometimes wraps JSON in ──────────────
function stripFences(text) {
    if (!text) return text;
    let t = String(text).trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
    if (fence) t = fence[1].trim();
    return t;
}

// ── ONE non-streaming Anthropic call. Throws on failure — caller reports & stops.
async function synthesizeOnce({ model, prompt }) {
    const resp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
            model: model || DEFAULT_MODEL,
            max_tokens: MAX_TOKENS,
            stream: false, // NON-streaming — avoids the "Premature close" the loop kept hitting
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Anthropic ${resp.status}: ${body.slice(0, 300)}`);
    }

    const data = await resp.json();
    const rawText = (data?.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

    if (!rawText) throw new Error('Anthropic returned empty content');

    const cleaned = stripFences(rawText);
    let script;
    try {
        script = JSON.parse(cleaned);
    } catch (_e) {
        throw new Error(`Anthropic output was not valid JSON: ${cleaned.slice(0, 300)}`);
    }
    return script;
}

// ── retry ONLY the callback POST (never synthesis). Reuses the given payload. ──
async function postCallback(url, secret, payload) {
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-worker-secret': secret },
                body: JSON.stringify(payload),
            });
            if (r.ok) return true;
            const body = await r.text().catch(() => '');
            lastErr = `${r.status}: ${body.slice(0, 300)}`;
            console.error(`[${payload.request_id}] callback rejected ${lastErr}`);
        } catch (e) {
            lastErr = String(e);
            console.error(`[${payload.request_id}] callback fetch error: ${lastErr}`);
        }
        if (attempt < 3) await new Promise((res) => setTimeout(res, 1000 * attempt)); // 1s, 2s backoff
    }
    // Give up on THIS job. We do NOT re-run synthesis and we do NOT requeue —
    // that is exactly what created the infinite Opus loop before.
    console.error(`[${payload.request_id}] callback failed after 3 attempts, dropping job. last=${lastErr}`);
    return false;
}

// ── background job: synthesize ONCE, then deliver the result (or the failure). ─
async function runJob({ requestId, model, prompt, callbackUrl }) {
    const secret = WORKER_SECRET;

    let script;
    try {
        script = await synthesizeOnce({ model, prompt });
    } catch (err) {
        // Synthesis failed. Report failure ONCE and STOP. No retry of Anthropic.
        console.error(`[${requestId}] synthesis failed: ${err.message}`);
        await postCallback(callbackUrl, secret, {
            request_id: requestId,
            status: 'failed',
            error: err.message,
        });
        return; // terminal — the loop ends here
    }

    // Synthesis succeeded. Deliver the finished script (only the POST retries).
    await postCallback(callbackUrl, secret, {
        request_id: requestId,
        status: 'completed',
        script,
    });
}

// ── /generate: validate, ACK 202 instantly, then run the job in the background ─
app.post('/generate', (req, res) => {
    if (!isAuthorized(req)) {
        return res.status(403).json({ error: 'forbidden' });
    }

    const {
        request_id: requestId,
        model,
        resolved_prompt: prompt,
        callback_url: payloadCallbackUrl,
    } = req.body || {};

    if (!requestId) return res.status(400).json({ error: 'missing request_id' });
    if (!prompt) return res.status(400).json({ error: 'missing resolved_prompt' });

    // Use the callback URL from the dispatch payload — the authoritative,
    // per-request target. Fall back to the env var only if the payload omits it.
    const callbackUrl = payloadCallbackUrl || FALLBACK_CALLBACK_URL;
    if (!callbackUrl) {
        return res.status(400).json({ error: 'no callback_url in payload and BASE44_CALLBACK_URL unset' });
    }
    if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    // ACK immediately so Base44's dispatch returns fast (no isolate timeout).
    res.status(202).json({ accepted: true, request_id: requestId });

    // Fire the slow work AFTER responding. Any unhandled error is caught so the
    // process never crashes (a crash + Railway restart would re-run the job).
    runJob({ requestId, model, prompt, callbackUrl }).catch((e) => {
        console.error(`[${requestId}] unhandled job error: ${e?.message || e}`);
    });
});

app.listen(PORT, () => {
    console.log(`[INFO] si-v5-worker listening on :${PORT}`);
});
