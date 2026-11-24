let cachedWorkingModel = null;

function parseJsonSafely(rawText) {
  if (typeof rawText !== 'string') return rawText;
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('Respons AI tidak berbentuk JSON valid.');
  }
}

async function discoverActiveModels(apiKey) {
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
          (name.includes('gemini') || name.includes('gemma-3')) &&
          !name.includes('image') &&
          !name.includes('audio') &&
          !name.includes('live') &&
          !name.includes('embedding') &&
          !name.includes('imagen') &&
          !name.includes('veo') &&
          !name.includes('tts') &&
          !name.includes('aqa') &&
          !name.includes('robotics') &&
          !name.includes('computer-use') &&
          !name.includes('deep-research')
        );
      })
      .map((m) => String(m.name).replace(/^models\//, ''))
      .sort((a, b) => {
        const score = (n) => {
          let s = 0;
          if (n.includes('2.5-flash')) s += 35;
          if (n.includes('3-flash')) s += 30;
          if (n.includes('flash')) s += 20;
          if (n.includes('gemma-3-12b')) s += 15;
          if (n.includes('gemma-3-27b')) s += 12;
          if (n.includes('gemma-3')) s += 8;
          if (n.includes('-pro')) s -= 5;
          return s;
        };
        return score(b) - score(a);
      });
  } catch {
    return [];
  }
}

function buildPayloadForModel(modelName, systemPrompt, userPrompt, responseSchema) {
  const lower = modelName.toLowerCase();
  const isGemma = lower.includes('gemma');

  if (isGemma) {
    const schemaHint = responseSchema
      ? `\n\nStruktur JSON WAJIB mengikuti skema berikut:\n${JSON.stringify(responseSchema)}`
      : '';
    const mergedText = [
      systemPrompt ? `INSTRUKSI SISTEM:\n${systemPrompt}` : '',
      `TUGAS:\n${userPrompt}${schemaHint}\n\nPENTING: Jawab HANYA dengan objek JSON valid tanpa teks pengantar, penutup, atau blok markdown.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      contents: [{ role: 'user', parts: [{ text: mergedText }] }],
      generationConfig: {
        temperature: 0.7,
      },
    };
  }

  const generationConfig = {
    temperature: 0.7,
    responseMimeType: 'application/json',
    responseSchema: responseSchema || undefined,
  };

  // Mempercepat pembuatan 5-10 soal sekaligus tanpa jeda thinking internal
  if (lower.includes('2.5-flash')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  return {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    generationConfig,
  };
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
      activeModel: cachedWorkingModel,
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
      ...(cachedWorkingModel ? [cachedWorkingModel] : []),
      'gemini-2.5-flash',
      'gemini-3-flash-preview',
      'gemini-flash-latest',
      'gemini-2.5-flash-lite',
      'gemma-3-12b-it',
      'gemma-3-27b-it',
    ];
    let hasDiscovered = false;
    let lastError = 'Gagal menghubungi layanan Gemini AI.';
    let lastStatus = 502;

    while (queue.length > 0 && triedModels.size < 8) {
      const modelName = queue.shift();
      if (!modelName || triedModels.has(modelName)) continue;
      triedModels.add(modelName);

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const controller = new AbortController();
      // Batas waktu 45 detik agar cukup untuk menyusun 5-10 soal sekaligus
      const timeoutId = setTimeout(() => controller.abort(), 45000);

      try {
        const googleRes = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(
            buildPayloadForModel(modelName, systemPrompt, userPrompt, responseSchema)
          ),
        });

        const data = await googleRes.json().catch(() => ({}));

        if (!googleRes.ok) {
          lastStatus = googleRes.status;
          lastError = data?.error?.message || `HTTP ${googleRes.status}`;
          if (cachedWorkingModel === modelName) cachedWorkingModel = null;

          if (!hasDiscovered) {
            hasDiscovered = true;
            const activeModels = await discoverActiveModels(apiKey);
            activeModels.forEach((m) => {
              if (!triedModels.has(m)) queue.push(m);
            });
          }

          if (
            googleRes.status === 400 ||
            googleRes.status === 404 ||
            googleRes.status === 429 ||
            googleRes.status === 500 ||
            googleRes.status === 502 ||
            googleRes.status === 503 ||
            googleRes.status === 504
          ) {
            continue;
          }

          console.error(`[api/gemini] Gagal (${googleRes.status}) pada ${modelName}:`, lastError);
          return res.status(googleRes.status).json({ ok: false, error: lastError });
        }

        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = parseJsonSafely(rawText);
        cachedWorkingModel = modelName;
        console.log(`[api/gemini] Sukses menggunakan model: ${modelName}`);
        return res.status(200).json({ ok: true, model: modelName, result: parsed });
      } catch (attemptErr) {
        if (cachedWorkingModel === modelName) cachedWorkingModel = null;
        lastStatus = attemptErr?.name === 'AbortError' ? 504 : 502;
        lastError =
          attemptErr?.name === 'AbortError'
            ? `Model ${modelName} melebihi batas waktu tunggu.`
            : attemptErr?.message || 'Koneksi ke Gemini terputus.';
        if (attemptErr?.name === 'AbortError') break;
        continue;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    console.error(`[api/gemini] Semua model gagal (${lastStatus}):`, lastError);
    return res.status(lastStatus).json({ ok: false, error: lastError });
  } catch (err) {
    console.error('[api/gemini] Server error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Terjadi kesalahan pada server /api/gemini.',
    });
  }
}
