module.exports = async function handler(req, res) {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

if (req.method === 'OPTIONS') return res.status(200).end();
if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

try {
const body = req.body;
const msgs = body.messages || [];
const isChasseur = body.tools && body.tools.length > 0;

if (isChasseur) {
const userContent = msgs[0] ? msgs[0].content : '';
const matchZones = userContent.match(/Zones\s*:\s*\*\*([^\*]+)\*\*/i);
const zones = matchZones ? matchZones[1].trim() : 'Paris 16e, Paris 15e, Paris 11e, Versailles';

const tRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
api_key: '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',
query: 'appartement renover ' + zones + ' vente prix euros',
max_results: 10,
search_depth: 'advanced'
})
});

const tData = await tRes.json();
const results = tData.results || [];
const annonces = [];

for (let i = 0; i < results.length; i++) {
const r = results[i];
const title = r.title || '';
const content = r.content || '';
const combined = title + ' ' + content;

// Extraire prix/m² EN PREMIER (plus fiable car format distinct)
let prix_m2 = 0;
const pm2Regex = /(\d{1,3}(?:[\s\u00a0]\d{3})*|\d+)\s*€\s*\/\s*m[²2]/gi;
let pm;
while ((pm = pm2Regex.exec(combined)) !== null) {
const val = parseInt(pm[1].replace(/[\s\u00a0]/g, ''), 10);
if (val >= 1000 && val <= 50000) { prix_m2 = val; break; }
}

// Extraire surface
let surface = 0;
const surfRegex = /(\d{1,4}(?:[,\.]\d{1,2})?)\s*m[²2]/gi;
let sm;
while ((sm = surfRegex.exec(combined)) !== null) {
const val = parseFloat(sm[1].replace(',', '.'));
if (val >= 10 && val <= 1000) { surface = val; break; }
}

// Extraire prix total
let prix = 0;
const prixRegex = /(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*€(?!\s*\/)/gi;
let m2;
while ((m2 = prixRegex.exec(combined)) !== null) {
const val = parseInt(m2[1].replace(/[\s\u00a0]/g, ''), 10);
if (val >= 50000 && val <= 50000000) { prix = val; break; }
}

// Déductions croisées
if (prix === 0 && prix_m2 > 0 && surface > 0) {
prix = Math.round(prix_m2 * surface);
}
if (prix_m2 === 0 && prix > 0 && surface > 0) {
prix_m2 = Math.round(prix / surface);
}

annonces.push({
adresse: title.substring(0, 80),
ville: zones.split(',')[0].trim(),
surface: Math.round(surface),
prix: prix,
prix_m2: prix_m2,
type: 'Appartement',
description: content.substring(0, 200),
lien: r.url || ''
});
}

return res.status(200).json({
content: [{ type: 'text', text: JSON.stringify({ annonces: annonces }) }]
});

} else {
const groqMsgs = msgs.map(function(m) {
return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
});

const cRes = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'x-api-key': process.env.ANTHROPIC_API_KEY,
'anthropic-version': '2023-06-01'
},
body: JSON.stringify({
model: 'claude-sonnet-4-6',
max_tokens: body.max_tokens || 2000,
messages: groqMsgs
})
});

const cData = await cRes.json();
const text = cData.content && cData.content[0] ? cData.content[0].text : 'Erreur de génération';

return res.status(200).json({
content: [{ type: 'text', text: text }]
});
}

} catch (err) {
return res.status(500).json({ error: err.message });
}
};
