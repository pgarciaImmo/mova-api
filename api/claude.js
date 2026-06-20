const { chercherAnnonces } = require('./lib/chasseur.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'false');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    const msgs = body.messages || [];
    const isChasseur = body.tools && body.tools.length > 0;

    if (isChasseur) {
      const userContent = msgs[0] ? msgs[0].content : '';
      const matchZones = userContent.match(/Zones\s*:\s*([^\n]+)/i);
      const zonesRaw = matchZones ? matchZones[1].trim() : 'Paris 16e, Paris 15e, Paris 11e, Versailles';
      const matchSurf = userContent.match(/Surface min\s*:\s*(\d+)/i);
      const surfMin = matchSurf ? parseInt(matchSurf[1]) : 17;

      const annonces = await chercherAnnonces(zonesRaw, surfMin);

      return res.status(200).json({
        content: [{ type: 'text', text: JSON.stringify({ annonces: annonces }) }]
      });

    } else {
      // Agents 02-04 : passthrough vers Groq (gratuit, llama-3.3-70b-versatile).
      const groqMsgs = msgs.map(function(m) {
        return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      });

      const gRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          max_tokens: body.max_tokens || 2000,
          messages: groqMsgs
        })
      });

      const gData = await gRes.json();
      const text = (gData.choices && gData.choices[0] && gData.choices[0].message)
        ? gData.choices[0].message.content
        : 'Erreur de génération';

      return res.status(200).json({
        content: [{ type: 'text', text: text }]
      });
    }

  } catch (err) {
    return res.status(500).json({
      content: [{ type: 'text', text: 'Erreur: ' + err.message }]
    });
  }
};
