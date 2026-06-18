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

const TAVILY_KEY = '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';

// Mots-clés en deux groupes pour les requêtes
const kwRenovation = 'rénover OR travaux OR succession OR liquidation OR rafraîchir OR restructurer OR "en l\'état" OR squatté';
const kwAtypique = 'atypique OR loft OR duplex OR hôtel OR commercialité OR immeuble OR bureau OR atelier OR "local commercial" OR Haussmannien';

const zones = zonesRaw.split(',').map(function(z) { return z.trim(); });
const zone1 = zones[0];
const zone2 = zones[1] || zones[0];

// Requêtes Tavily — simples et efficaces
const queries = [
zone1 + ' appartement vente ' + kwRenovation,
zone1 + ' vente ' + kwAtypique,
zone2 + ' appartement vente ' + kwRenovation,
zone1 + ' immeuble bureau local commercial vente prix euros'
];

const allResults = [];

for (let q = 0; q < queries.length; q++) {
try {
const tRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
api_key: TAVILY_KEY,
query: queries[q],
max_results: 5,
search_depth: 'advanced'
})
});
const tData = await tRes.json();
if (tData.results) allResults.push(...tData.results);
} catch (e) {}
}

// PAP RSS
try {
const papRss = await fetch('https://www.pap.fr/rss/annonces-ventes-immobilieres.rss?geo=r159&type=appartement&nb_pieces_min=1');
const papText = await papRss.text();
const items = papText.match(/<item>([\s\S]*?)<\/item>/g) || [];
items.slice(0, 6).forEach(function(item) {
const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || '';
const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || [])[1] || '';
if (title && link) {
allResults.push({ title: title, url: link, content: desc });
}
});
} catch (e) {}

// Dédoublonnage
const seen = {};
const unique = allResults.filter(function(r) {
if (!r.url || seen[r.url]) return false;
seen[r.url] = true;
return true;
});

const annonces = [];

for (let i = 0; i < unique.length; i++) {
const r = unique[i];
const title = r.title || '';
const content = r.content || '';
const combined = title + ' ' + content;
const url = r.url || '';

// Extraire prix/m²
let prix_m2 = 0;
const pm2Regex = /(\d{1,3}(?:[\s\u00a0]\d{3})*|\d{4,6})\s*[€e]\s*\/\s*m[²2]/gi;
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
if (val >= surfMin && val <= 5000) { surface = val; break; }
}

// Extraire prix total — multiple patterns
let prix = 0;
const prixPatterns = [
/(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*€/gi,
/(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*euros?/gi,
/(\d{3,4})\s*000\s*€/gi,
/prix\s*:?\s*(\d{1,3}(?:[\s\u00a0]\d{3})+)/gi,
/(\d{1,3}(?:\.\d{3})+)\s*€/gi
];
for (let p = 0; p < prixPatterns.length && prix === 0; p++) {
let m2;
prixPatterns[p].lastIndex = 0;
while ((m2 = prixPatterns[p].exec(combined)) !== null) {
const raw = m2[1].replace(/[\s\u00a0\.]/g, '');
const val = parseInt(raw, 10);
if (val >= 50000 && val <= 50000000) { prix = val; break; }
}
}

// Déductions croisées
if (prix === 0 && prix_m2 > 0 && surface > 0) prix = Math.round(prix_m2 * surface);
if (prix_m2 === 0 && prix > 0 && surface > 0) prix_m2 = Math.round(prix / surface);

// Source
let source = 'Web';
if (url.includes('seloger.com')) source = 'SeLoger';
else if (url.includes('leboncoin.fr')) source = 'LeBonCoin';
else if (url.includes('pap.fr')) source = 'PAP';
else if (url.includes('notaires.fr')) source = 'Notaires';
else if (url.includes('bienici.com')) source = 'Bienici';
else if (url.includes('logic-immo.com')) source = 'Logic-Immo';
else if (url.includes('etreproprio.com')) source = 'EtreProprio';

// Type de bien
const lc = combined.toLowerCase();
let type = 'Appartement';
if (lc.includes('immeuble entier') || lc.includes('immeuble de rapport')) type = 'Immeuble';
else if (lc.includes('bureau')) type = 'Bureau';
else if (lc.includes('commerce') || lc.includes('boutique') || lc.includes('local commercial')) type = 'Commerce';
else if (lc.includes('atelier') || lc.includes('entrepôt')) type = 'Industriel';
else if (lc.includes('maison') || lc.includes('pavillon')) type = 'Maison';
else if (lc.includes('hôtel') && !lc.includes('hôtel particulier')) type = 'Hôtel';
else if (lc.includes('loft') || lc.includes('duplex') || lc.includes('triplex')) type = 'Atypique';

annonces.push({
adresse: title.substring(0, 80),
ville: zone1,
surface: surface > 0 ? Math.round(surface) : null,
prix: prix > 0 ? prix : null,
prix_m2: prix_m2 > 0 ? prix_m2 : null,
type: type,
source: source,
description: content.substring(0, 250),
lien: url
});
}

return res.status(200).json({
content: [{ type: 'text', text: JSON.stringify({ annonces: annonces }) }]
});

} else {
// Agents 2-5
const groqMsgs = msgs.map(function(m) {
return {
role: m.role,
content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
};
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
return res.status(500).json({
content: [{ type: 'text', text: 'Erreur: ' + err.message }]
});
}
};
