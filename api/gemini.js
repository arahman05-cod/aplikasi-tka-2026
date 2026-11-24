let cachedWorkingModel = null;
let keyCursor = 0;
let groqKeyCursor = 0;

function parseMultiKeys(rawValue) {
  return String(rawValue || '')
    .split(/[\n,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function getGeminiApiKeys() {
  return parseMultiKeys(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
}

function getGroqApiKeys() {
  return parseMultiKeys(process.env.GROQ_API_KEY || '');
}

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
  const speedDirective =
    '\n\nATURAN KECEPATAN: Susun konten secara tajam, langsung ke inti HOTS, dan padat tanpa kalimat basa-basi.';

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

async function callGroqFallback(groqKey, systemPrompt, userPrompt) {
  const schemaInstruction = `\n\nWAJIB keluarkan HANYA JSON valid dengan format persis:
{"items":[{"deepLearningPhase":"...","graduateDimension":"...","material":"...","stimulusType":"...","indicator":"...","cognitiveLevel":"L2 - Aplikasi (C3) atau L3 - Penalaran (C4)","questionType":"PG atau PG_KOMPLEKS atau BENAR_SALAH","questionText":"...","optionStructureSummary":"...","options":["opsi 1","opsi 2","opsi 3","opsi 4","opsi 5"],"correctPgIndex":0,"correctMultiIndices":[0,1],"correctBsBooleans":[true,false,true,false,true]}]}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 18000);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.65,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `${systemPrompt || 'Anda adalah penyusun soal TKA profesional.'}${schemaInstruction}`,
          },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Groq HTTP ${res.status}`);
    }

    const rawText = data?.choices?.[0]?.message?.content || '';
    return parseJsonSafely(rawText);
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const geminiKeys = getGeminiApiKeys();
  const groqKeys = getGroqApiKeys();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      hasKey: geminiKeys.length > 0 || groqKeys.length > 0,
      geminiKeyCount: geminiKeys.length,
      hasGroqFallback: groqKeys.length > 0,
      groqKeyCount: groqKeys.length,
      activeModel: cachedWorkingModel,
      message: 'Server API TKA siap digunakan.',
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Metode tidak diizinkan.' });
  }

  if (geminiKeys.length === 0 && groqKeys.length === 0) {
    return res.status(500).json({
      ok: false,
      error: 'GEMINI_API_KEY atau GROQ_API_KEY belum dipasang di Environment Variables Vercel.',
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { systemPrompt, userPrompt, responseSchema } = body;

    if (!userPrompt) {
      return res.status(400).json({ ok: false, error: 'Prompt tidak boleh kosong.' });
    }

    let lastError = 'Gagal menghubungi layanan AI.';
    let lastStatus = 502;

    if (geminiKeys.length > 0) {
      const baseModels = [
        ...(cachedWorkingModel ? [cachedWorkingModel] : []),
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-3-flash-preview',
      ];
      const uniqueModels = [...new Set(baseModels)];

      const rotatedKeys = geminiKeys.map(
        (_, idx) => geminiKeys[(keyCursor + idx) % geminiKeys.length]
      );
      keyCursor = (keyCursor + 1) % geminiKeys.length;

      for (let kIdx = 0; kIdx < rotatedKeys.length; kIdx++) {
        const currentKey = rotatedKeys[kIdx];

        for (const modelName of uniqueModels) {
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(currentKey)}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 18000);

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
            } else {
              const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              const parsed = parseJsonSafely(rawText);
              cachedWorkingModel = modelName;
              console.log(`[api/gemini] Sukses menggunakan ${modelName} (Gemini Key #${kIdx + 1})`);
              return res.status(200).json({ ok: true, model: modelName, result: parsed });
            }
          } catch (attemptErr) {
            if (cachedWorkingModel === modelName) cachedWorkingModel = null;
            lastStatus = attemptErr?.name === 'AbortError' ? 504 : 502;
            lastError =
              attemptErr?.name === 'AbortError'
                ? `Model ${modelName} melebihi batas waktu tunggu.`
                : attemptErr?.message || 'Koneksi ke Gemini terputus.';
          } finally {
            clearTimeout(timeoutId);
          }
        }
      }
    }

    // Cadangan otomatis multi-key ke Groq jika semua API Key Gemini penuh
    if (groqKeys.length > 0) {
      const rotatedGroqKeys = groqKeys.map(
        (_, idx) => groqKeys[(groqKeyCursor + idx) % groqKeys.length]
      );
      groqKeyCursor = (groqKeyCursor + 1) % groqKeys.length;

      for (let gIdx = 0; gIdx < rotatedGroqKeys.length; gIdx++) {
        try {
          const parsedGroq = await callGroqFallback(
            rotatedGroqKeys[gIdx],
            systemPrompt,
            userPrompt
          );
          console.log(`[api/gemini] Sukses menggunakan cadangan Groq (Key #${gIdx + 1})`);
          return res.status(200).json({
            ok: true,
            model: 'groq/llama-3.3-70b-versatile',
            result: parsedGroq,
          });
        } catch (groqErr) {
          lastError = `Groq Key #${gIdx + 1} gagal: ${groqErr?.message || lastError}`;
        }
      }
    }

    console.error(`[api/gemini] Semua penyedia gagal (${lastStatus}):`, lastError);
    return res.status(lastStatus).json({ ok: false, error: lastError });
  } catch (err) {
    console.error('[api/gemini] Server error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Terjadi kesalahan pada server /api/gemini.',
    });
  }
}
