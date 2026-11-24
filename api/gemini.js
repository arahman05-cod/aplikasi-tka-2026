export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();

  // Endpoint pengecekan cepat lewat browser: /api/gemini
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

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
    let lastError = 'Gagal menghubungi layanan Gemini AI.';

    for (let i = 0; i < models.length; i++) {
      const modelName = models[i];
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;

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

      const data = await googleRes.json();

      if (!googleRes.ok) {
        lastError = data?.error?.message || `HTTP ${googleRes.status}`;
        if ((googleRes.status === 404 || googleRes.status === 429) && i < models.length - 1) {
          continue;
        }
        return res.status(googleRes.status).json({ ok: false, error: lastError });
      }

      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
      return res.status(200).json({ ok: true, model: modelName, result: parsed });
    }

    return res.status(502).json({ ok: false, error: lastError });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Terjadi kesalahan pada server /api/gemini.',
    });
  }
}
