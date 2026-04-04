export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });

  // 1. Fetch de la page
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

  // 2. Appel Claude
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'no_api_key' });

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: 'Tu es un extracteur de recettes de cuisine. On te donne le texte brut dune page web. Extrais la recette et reponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, avec exactement ces champs: name (string), category (string parmi: Entree, Plat, Soupe / Potage, Dessert, Aperitif, Petit-dejeuner, Autre), prepTime (nombre entier de minutes ou null), servings (nombre entier ou null), ingredients (string, un ingredient par ligne), instructions (string, une etape par ligne). Si pas de recette trouvee reponds uniquement: {"error":"no_recipe"}',
        messages: [{ role: 'user', content: 'Extrais la recette depuis ce texte:\n\n' + pageContent }]
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
