function parseJsonSafely(rawText) {
  if (typeof rawText !== 'string') return rawText;
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

async function discoverActiveGeminiModels(apiKey) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];

    return models
      .filter((m) => {
        const methods = Array.isArray(m.supportedGenerationMethods)
          ? m.supportedGenerationMethods
          : [];
        const name = String(m.name || '').toLowerCase();
        return (
          methods.includes('generateContent') &&
          name.includes('gemini') &&
          !name.includes('embedding') &&
          !name.includes('imagen') &&
          !name.includes('veo') &&
          !name.includes('tts') &&
          !name.includes('aqa') &&
          !name.includes('robotics') &&
          !name.includes('computer-use')
        );
      })
      .map((m) => String(m.name).replace(/^models\//, ''))
      .sort((a, b) => {
        const score = (n) => {
          let s = 0;
          if (n.includes('flash')) s += 10;
          if (n.includes('2.5') || n.includes('3')) s += 5;
          if (n.includes('lite')) s -= 1;
          if (n.includes('preview') || n.includes('exp')) s -= 2;
          return s;
        };
        return score(b) - score(a);
      });
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      hasKey: Boolean(apiKey),
      message: apiKey
        ? 'Server API Gemini TKA siap digunakan.'
        : 'GEMINI_API_KEY belum diisi di Environment Variables Vercel.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Metode tidak diizinkan.' });
  }

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: 'GEMINI_API_KEY belum dipasang di Environment Variables Vercel.',
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { systemPrompt, userPrompt, responseSchema } = body;

    if (!userPrompt) {
      return res.status(400).json({ ok: false, error: 'Prompt tidak boleh kosong.' });
    }

    const triedModels = new Set();
    const queue = [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-flash-latest',
      'gemini-2.0-flash',
    ];
    let hasDiscovered = false;
    let lastError = 'Gagal menghubungi layanan Gemini AI.';
    let lastStatus = 502;

    while (queue.length > 0) {
      const modelName = queue.shift();
      if (!modelName || triedModels.has(modelName)) continue;
      triedModels.add(modelName);

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const googleRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
          generationConfig: {
            temperature: 0.75,
            responseMimeType: 'application/json',
            responseSchema: responseSchema || undefined,
          },
        }),
      });

      const data = await googleRes.json().catch(() => ({}));

      if (!googleRes.ok) {
        lastStatus = googleRes.status;
        lastError = data?.error?.message || `HTTP ${googleRes.status}`;
        console.error(`[api/gemini] Model ${modelName} gagal (${googleRes.status}):`, lastError);

        if (googleRes.status === 404 && !hasDiscovered) {
          hasDiscovered = true;
          const activeModels = await discoverActiveGeminiModels(apiKey);
          activeModels.forEach((m) => {
            if (!triedModels.has(m)) queue.push(m);
          });
        }

        if (googleRes.status === 404 || googleRes.status === 429 || googleRes.status === 503) {
          continue;
        }

        return res.status(googleRes.status).json({ ok: false, error: lastError });
      }

      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = parseJsonSafely(rawText);
      return res.status(200).json({ ok: true, model: modelName, result: parsed });
    }

    return res.status(lastStatus).json({ ok: false, error: lastError });
  } catch (err) {
    console.error('[api/gemini] Server error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Terjadi kesalahan pada server /api/gemini.',
    });
  }
}
