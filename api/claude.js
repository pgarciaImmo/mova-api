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
// ── AGENT 5 : CHASSEUR ──────────────────────────────────────────
const userContent = msgs[0] ? msgs[0].content : '';

// Extraire les zones depuis le message
const matchZones = userContent.match(/Zones\s*:\s*\*\*([^\*]+)\*\*/i);
const zones = matchZones ? matchZones[1].trim() : 'Paris 16e, Paris 15e, Paris 11e, Versailles';

// Recherche Tavily
const tRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
api_key: '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',
query: 'appartement renover ' + zones + ' vente prix euros',
max_results: 10,
search_depth: 'basic'
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

// Extraire prix
let prix = 0;
const prixPatterns = [
/(\d[\d\s]{2,8})\s*000\s*€/i,
/(\d{3,4})\s*000\s*euros/i,
/prix\s*:\s*(\d[\d\s]{2,8})\s*€/i,
/(\d\d\d[\d\s]{1,4})\s*€/i
];
for (let p = 0; p < prixPatterns.length; p++) {
const pm = combined.match(prixPatterns[p]);
if (pm) {
const raw = pm[1].replace(/\s/g, '');
const val = parseInt(raw);
if (val > 10000 && val < 50000000) { prix = val; break; }
}
}

// Extraire surface
let surface = 0;
const surfPatterns = [
/(\d+[\.,]\d+)\s*m[²2]/i,
/(\d+)\s*m[²2]/i,
/surface\s*:\s*(\d+)/i
];
for (let p = 0; p < surfPatterns.length; p++) {
const sm = combined.match(surfPatterns[p]);
if (sm) {
surface = parseFloat(sm[1].replace(',', '.'));
if (surface > 5 && surface < 2000) break;
else surface = 0;
}
}

const prix_m2 = (prix > 0 && surface > 0) ? Math.round(prix / surface) : 0;

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
// ── AGENTS 1–4 : CLAUDE ─────────────────────────────────────────
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
}
