import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

async function extractMagimixInstructions(pdfBuffer) {
  try {
    const uint8Array = new Uint8Array(pdfBuffer.buffer || pdfBuffer, pdfBuffer.byteOffset || 0, pdfBuffer.byteLength);
    const doc = await getDocument({ data: uint8Array, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();

    const items = tc.items
      .filter(i => i.str.trim())
      .map(i => ({ x: Math.round(i.transform[4]), y: Math.round(i.transform[5]), t: i.str.trim() }));

    const ROBOT_MODES = ['EXPERT', 'MIJOTAGE', 'AUTO', 'TURBO'];

    // Numéros d'étapes (x ~533, chiffre seul)
    const stepNums = items.filter(i => i.x >= 520 && i.x <= 550 && /^\d+$/.test(i.t));
    // Textes d'étapes (x ~308, phrase longue)
    const stepTexts = items.filter(i => i.x >= 300 && i.x <= 320 && i.t.length > 20);
    // Modes robot (x >= 590)
    const robotModes = items.filter(i => i.x >= 590 && ROBOT_MODES.includes(i.t));
    // Paramètres robot (contient HH:MM)
    const robotParams = items.filter(i => i.x >= 580 && /\d+:\d+/.test(i.t));

    // Associer chaque mode robot à son étape
    const robotByStep = {};
    robotModes.forEach(mode => {
      const params = robotParams.find(p => Math.abs(p.y - mode.y) <= 15);
      const stepNum = stepNums
        .filter(s => s.y > mode.y && s.y - mode.y < 90)
        .sort((a, b) => a.y - b.y)[0];

      if (stepNum && params) {
        const parts = params.t.split('/').map(p => p.trim());
        const timeMatch = params.t.match(/(\d+):(\d+)/);
        if (!timeMatch) return;
        const totalSec = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
        const timeStr = totalSec >= 60 ? (totalSec / 60) + 'min' : totalSec + 'sec';
        const vitesse = parts[1] || '';
        const temp = parts[2] || '';
        let robot = `[ROBOT ${mode.t}] ${timeStr}`;
        if (vitesse && !vitesse.includes('__')) robot += ` / Vitesse ${vitesse}`;
        if (temp && !temp.includes('__')) robot += ` / ${temp}`;
        robotByStep[parseInt(stepNum.t)] = robot;
      }
    });

    // Associer texte au numéro d'étape
    const instructions = stepNums
      .map(sn => {
        const num = parseInt(sn.t);
        const text = stepTexts
          .filter(st => sn.y - st.y > 0 && sn.y - st.y < 280)
          .sort((a, b) => b.y - a.y)[0];
        let line = text ? text.t : '';
        if (robotByStep[num]) line += ' ' + robotByStep[num];
        return { num, line };
      })
      .sort((a, b) => a.num - b.num)
      .map(s => s.line)
      .filter(Boolean)
      .join('\n');

    return instructions || null;
  } catch(e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'no_api_key' });

  const { url, imageBase64, imagesBase64, pdfBase64 } = req.body || {};

  const SYSTEM = `Tu es un extracteur de recettes de cuisine. Extrais la recette et reponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, avec exactement ces champs:
- name (string)
- category (string parmi: Entree, Plat, Dessert, Aperitif, Petit-dejeuner, Autre)
- prepTime (nombre entier de minutes ou null)
- servings (nombre entier ou null)
- ingredients (string, un ingredient par ligne)
- instructions (string, une etape par ligne)

Si les instructions te sont fournies pre-formatees avec [ROBOT MODE], conserve-les exactement telles quelles.
Si pas de recette trouvee: {"error":"no_recipe"}`;

  let messages;

  if (pdfBase64) {
    // Extraire les instructions Magimix avec le parser structurel
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const magimixInstructions = await extractMagimixInstructions(pdfBuffer);

    if (magimixInstructions) {
      // On a les instructions avec consignes robot — envoyer le texte brut + instructions pré-parsées
      messages = [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `Extrais la recette (nom, categorie, temps, servings, ingredients). Pour les instructions, utilise EXACTEMENT ceci:\n\n${magimixInstructions}` }
        ]
      }];
    } else {
      // Fallback : mode standard sans parser
      messages = [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: 'Extrais la recette complete de ce PDF.' }
        ]
      }];
    }
  } else if (imagesBase64 && Array.isArray(imagesBase64) && imagesBase64.length > 0) {
    const imageContents = imagesBase64.map((img) => {
      const base64Data = img.replace(/^data:image\/\w+;base64,/, '');
      const mediaType = img.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } };
    });
    messages = [{
      role: 'user',
      content: [
        ...imageContents,
        { type: 'text', text: 'Ces ' + imagesBase64.length + ' photos montrent une meme recette dans l\'ordre. Reconstitue la recette complete sans doublons.' }
      ]
    }];
  } else if (imageBase64) {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = imageBase64.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
        { type: 'text', text: 'Extrais la recette presente sur cette photo.' }
      ]
    }];
  } else if (url) {
    let pageContent = '';
    try {
      const pageRes = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Saveurs-App/1.0)' },
        signal: AbortSignal.timeout(10000)
      });
      const html = await pageRes.text();
      pageContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 8000);
    } catch (e) {
      return res.status(200).json({ error: 'fetch_failed', detail: e.message });
    }
    messages = [{ role: 'user', content: 'Extrais la recette depuis ce texte:\n\n' + pageContent }];
  } else {
    return res.status(400).json({ error: 'Missing url, imageBase64, imagesBase64 or pdfBase64' });
  }

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: SYSTEM,
        messages
      })
    });

    const data = await apiRes.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const recipe = JSON.parse(clean);
    return res.status(200).json(recipe);
  } catch (e) {
    return res.status(200).json({ error: 'api_error', detail: e.message });
  }
}
