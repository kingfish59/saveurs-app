export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'no_api_key' });

  const { url, imageBase64, imagesBase64, pdfBase64 } = req.body || {};

  const SYSTEM_PDF = `Tu es un extracteur de recettes de cuisine pour robot Magimix. Reponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, avec ces champs:
- name (string)
- category (string parmi: Entree, Plat, Dessert, Aperitif, Petit-dejeuner, Autre)
- prepTime (nombre entier de minutes ou null)
- servings (nombre entier ou null)
- ingredients (string, un ingredient par ligne)
- instructions (string, une etape par ligne)

STRUCTURE SPECIFIQUE DES PDF MAGIMIX:
Le PDF contient deux blocs distincts:
BLOC A (en haut): les etapes numerotees 1, 2, 3... avec leur texte mais SANS les consignes robot
BLOC B (en bas): pour chaque etape (sauf etape 1), les ingredients de cette etape SUIVIS de la consigne robot (EXPERT/MIJOTAGE + duree/vitesse/temperature)

BLOC B exemple:
"1 oignon / 20g gingembre / 2 gousses d ail / EXPERT / 02:00 / 13 / __ C" -> correspond a l etape 2
"30g beurre / 1 c.c. huile / EXPERT / 05:00 / 1A / 110 C" -> correspond a l etape 3
"1 tomate / 30g concentre tomate / MIJOTAGE / 10:00 / 1A / 110 C" -> correspond a l etape 4
"20g noix cajou / 200g creme / EXPERT / 00:30 / 5 / __ C" -> correspond a l etape 5
"EXPERT / 10:00 / 1A / 110 C" -> correspond a l etape 6

Tu dois FUSIONNER les deux blocs: prendre le texte de chaque etape du BLOC A et lui ajouter la consigne robot du BLOC B correspondant.

Resultat attendu pour les instructions:
"Coupez le poulet... Laissez mariner 60 minutes."
"Mettez l oignon, le gingembre et l ail dans le bol inox. [ROBOT EXPERT] 2min / Vitesse 13"
"Ajoutez le beurre et l huile. [ROBOT EXPERT] 5min / Vitesse 1A / 110 C"
"Deposez la tomate et le concentre. [ROBOT MIJOTAGE] 10min / Vitesse 1A / 110 C"
"Ajoutez les noix de cajou et la creme. [ROBOT EXPERT] 30sec / Vitesse 5"
"Ajoutez le poulet marine. [ROBOT EXPERT] 10min / Vitesse 1A / 110 C"

Si pas de recette trouvee: {"error":"no_recipe"}`;

  const SYSTEM_OTHER = `Tu es un extracteur de recettes de cuisine. Extrais la recette et reponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, avec exactement ces champs:
- name (string)
- category (string parmi: Entree, Plat, Dessert, Aperitif, Petit-dejeuner, Autre)
- prepTime (nombre entier de minutes ou null)
- servings (nombre entier ou null)
- ingredients (string, un ingredient par ligne)
- instructions (string, une etape par ligne)

Pour les recettes robot (Magimix, Thermomix), inclus les consignes robot dans chaque etape sous la forme [ROBOT MODE] Xmin / VitesseY / Z C.
Si pas de recette trouvee: {"error":"no_recipe"}`;

  let messages;
  let model = 'claude-haiku-4-5-20251001';
  let system = SYSTEM_OTHER;

  if (pdfBase64) {
    model = 'claude-sonnet-4-6';
    system = SYSTEM_PDF;
    messages = [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: 'Extrais la recette. FUSIONNE le BLOC A (etapes texte) avec le BLOC B (consignes robot en bas) pour inclure les parametres robot dans chaque etape.' }
      ]
    }];
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
        { type: 'text', text: 'Ces ' + imagesBase64.length + ' photos montrent une meme recette dans l\'ordre. Reconstitue la recette complete sans doublons. Inclus les consignes robot avec [ROBOT MODE].' }
      ]
    }];
  } else if (imageBase64) {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = imageBase64.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
        { type: 'text', text: 'Extrais la recette. Inclus les consignes robot avec [ROBOT MODE].' }
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
    messages = [{
      role: 'user',
      content: 'Extrais la recette depuis ce texte:\n\n' + pageContent
    }];
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
      body: JSON.stringify({ model, max_tokens: 2000, system, messages })
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
