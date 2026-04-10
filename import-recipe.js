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

REGLES CRITIQUES POUR LES RECETTES MAGIMIX / ROBOT CUISEUR:

Le PDF Magimix presente les etapes en deux colonnes:
- Colonne gauche: texte de l'etape + liste d'ingredients de cette etape
- Colonne droite: consigne robot (mode + duree + vitesse + temperature)

La consigne robot de la colonne droite appartient TOUJOURS a l'etape de la colonne gauche sur la meme ligne.

Formats de consignes robot possibles:
- "EXPERT 05:00 / 1A / 110 C" = mode Expert, 5 minutes, vitesse 1A, 110 degres
- "MIJOTAGE 10:00 / 1A / 110 C" = mode Mijotage, 10 minutes, vitesse 1A, 110 degres
- "EXPERT 02:00 / 13 / __ C" = mode Expert, 2 minutes, vitesse 13, sans temperature
- "AUTO 05:00 / __ / __ C" = mode Auto, 5 minutes

Pour CHAQUE etape ayant une consigne robot, formate l'instruction ainsi:
Texte de l'etape. [ROBOT mode] Xmin / VitesseY / Z degC
Si temperature absente: [ROBOT mode] Xmin / VitesseY

Exemple concret:
Etape 2 texte: "Mettez l'oignon, le gingembre et l'ail dans le bol inox. Lancez le programme."
Consigne droite: "EXPERT 02:00 / 13 / __ C"
Resultat attendu: "Mettez l'oignon, le gingembre et l'ail dans le bol inox. Lancez le programme. [ROBOT EXPERT] 2min / Vitesse 13"

Etape 3 texte: "Ajoutez le beurre et l'huile d'olive, puis lancez le programme."
Consigne droite: "EXPERT 05:00 / 1A / 110 C"
Resultat attendu: "Ajoutez le beurre et l'huile d'olive. [ROBOT EXPERT] 5min / Vitesse 1A / 110 degC"

NE JAMAIS omettre les consignes robot. Elles sont essentielles pour utiliser le robot correctement.

Si pas de recette trouvee reponds uniquement: {"error":"no_recipe"}`;

  let messages;

  if (pdfBase64) {
    messages = [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: 'Extrais la recette complete. IMPORTANT: associe chaque consigne robot (colonne droite: EXPERT/MIJOTAGE avec duree/vitesse/temperature) a l\'etape correspondante (colonne gauche) et inclus-la dans les instructions avec le prefixe [ROBOT MODE].' }
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
        { type: 'text', text: 'Ces ' + imagesBase64.length + ' photos montrent une meme recette dans l\'ordre. Reconstitue la recette complete sans doublons. Associe chaque consigne robot (icone chapeau orange avec duree/vitesse/temperature) a l\'etape correspondante avec le prefixe [ROBOT MODE].' }
      ]
    }];
  } else if (imageBase64) {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = imageBase64.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
        { type: 'text', text: 'Extrais la recette. Associe chaque consigne robot (icone chapeau orange avec duree/vitesse/temperature) a l\'etape correspondante avec le prefixe [ROBOT MODE].' }
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
      body: JSON.stringify({
        model: pdfBase64 ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001',
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
