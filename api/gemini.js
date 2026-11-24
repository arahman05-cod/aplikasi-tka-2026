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

function buildPayloadForModel(
  modelName,
  systemPrompt,
  userPrompt,
  responseSchema,
  fastMode = true
) {
  const lower = modelName.toLowerCase();
  const isGemma = lower.includes('gemma');
  const speedDirective =
    '\n\nATURAN KECEPATAN: Susun konten secara tajam, langsung ke inti HOTS, dan padat tanpa kalimat basa-basi.';

  if (isGemma) {
    const schemaHint = responseSchema
      ? `\n\nStruktur JSON WAJIB mengikuti skema berikut:\n${JSON.stringify(responseSchema)}`
      : '';
    const mergedText = [
      systemPrompt ? `INSTRUKSI SISTEM:\n${systemPrompt}${speedDirective}` : speedDirective,
      `TUGAS:\n${userPrompt}${schemaHint}\n\nPENTING: Jawab HANYA dengan objek JSON valid tanpa teks pengantar, penutup, atau blok markdown.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      contents: [{ role: 'user', parts: [{ text: mergedText }] }],
      generationConfig: {
        temperature: 0.65,
      },
    };
  }

  const generationConfig = {
    temperature: 0.65,
    responseMimeType: 'application/json',
    responseSchema: responseSchema || undefined,
  };

  if (fastMode) {
    if (lower.includes('2.5-flash')) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    } else if (lower.includes('gemini-3')) {
      generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
    }
  }

  return {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    systemInstruction: {
      parts: [{ text: `${systemPrompt || 'Anda adalah penyusun soal TKA profesional.'}${speedDirective}` }],
    },
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
    // Hanya 5 model tercepat lintas keluarga (Gemini 2.5, Gemma 3, dan Gemini 3)
    const queue = [
      ...(cachedWorkingModel ? [cachedWorkingModel] : []),
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemma-3-27b-it',
      'gemma-3-12b-it',
      'gemini-3-flash-preview',
    ];
    let lastError = 'Gagal menghubungi layanan Gemini AI.';
    let lastStatus = 502;

    while (queue.length > 0) {
      const modelName = queue.shift();
      if (!modelName || triedModels.has(modelName)) continue;
      triedModels.add(modelName);

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const controller = new AbortController();
      // 9.5 detik per model: cukup untuk 1 soal (normal 2-4 detik), cepat pindah jika padat
      const timeoutId = setTimeout(() => controller.abort(), 9500);

      try {
        let googleRes = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(
            buildPayloadForModel(modelName, systemPrompt, userPrompt, responseSchema, true)
          ),
        });

        let data = await googleRes.json().catch(() => ({}));

        if (
          !googleRes.ok &&
          googleRes.status === 400 &&
          String(data?.error?.message || '').toLowerCase().includes('thinking')
        ) {
          googleRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify(
              buildPayloadForModel(modelName, systemPrompt, userPrompt, responseSchema, false)
            ),
          });
          data = await googleRes.json().catch(() => ({}));
        }

        if (!googleRes.ok) {
          lastStatus = googleRes.status;
          lastError = data?.error?.message || `HTTP ${googleRes.status}`;
          if (cachedWorkingModel === modelName) cachedWorkingModel = null;

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
