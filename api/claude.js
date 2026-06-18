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
const zone1 = zonesRaw.split(',')[0].trim();
const matchSurf = userContent.match(/Surface min\s*:\s*(\d+)/i);
const surfMin = matchSurf ? parseInt(matchSurf[1]) : 17;

const TAVILY_KEY = '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';

// Requêtes Tavily ciblées annonces individuelles SeLoger + LeBonCoin
const tavilyQueries = [
'site:seloger.com/annonces appartement rénover travaux vente ' + zone1 + ' prix euros',
'site:leboncoin.fr/ventes_immobilieres appartement travaux rénover ' + zone1 + ' prix euros',
'site:seloger.com/annonces appartement vente ' + zonesRaw.split(',').slice(1,3).join(' ') + ' travaux prix euros',
'site:pap.fr appartement rénover vente ' + zone1 + ' prix euros'
];

const allResults = [];

for (let q = 0; q < tavilyQueries.length; q++) {
try {
const tRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
api_key: TAVILY_KEY,
query: tavilyQueries[q],
max_results: 5,
search_depth: 'advanced',
include_domains: ['seloger.com', 'leboncoin.fr', 'pap.fr', 'bienici.com']
})
});
const tData = await tRes.json();
if (tData.results) allResults.push(...tData.results);
} catch (e) {}
}

// PAP RSS flux officiel
try {
const papUrl = 'https://www.pap.fr/annonce/ventes-appartements-' + encodeURIComponent(zone1.toLowerCase().replace(/\s+/g, '-')) + '-r159?surface_min=' + surfMin + '&produit=appartement';
const papRss = await fetch('https://www.pap.fr/rss/annonces-ventes-immobilieres.rss?geo=r159&type=appartement');
const papText = await papRss.text();
// Parser RSS simple
const items = papText.match(/<item>([\s\S]*?)<\/item>/g) || [];
items.slice(0, 5).forEach(function(item) {
const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || '';
const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || [])[1] || '';
if (title && link) {
allResults.push({
title: title,
url: link,
content: desc,
source: 'PAP'
});
}
});
} catch (e) {}

// Notaires.fr
try {
const notRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
api_key: TAVILY_KEY,
query: 'site:imobilier.notaires.fr appartement vente ' + zone1 + ' prix euros rénover',
max_results: 3,
search_depth: 'advanced',
include_domains: ['imobilier.notaires.fr']
})
});
const notData = await notRes.json();
if (notData.results) allResults.push(...notData.results);
} catch (e) {}

// Dédoublonnage par URL
const seen = {};
const unique = allResults.filter(function(r) {
if (!r.url || seen[r.url]) return false;
seen[r.url] = true;
return true;
});

// Filtrer uniquement les URLs d'annonces individuelles
const annoncePatterns = [
/seloger\.com\/annonces\/\d+/,
/leboncoin\.fr\/ventes_immobilieres\/\d+/,
/leboncoin\.fr\/ad\/ventes_immobilieres\/\d+/,
/pap\.fr\/annonce\//,
/bienici\.com\/annonce\//,
/imobilier\.notaires\.fr\/.+\/annonce\//,
/imobilier\.notaires\.fr\/annonce\//
];

// Sources à exclure
const excluded = ['valuo', 'architecte', 'blog', 'conseil', 'formation', 'guide', 'wikipedia', 'prix-immobilier', 'estimation'];

const annonces = [];

for (let i = 0; i < unique.length; i++) {
const r = unique[i];
const title = r.title || '';
const content = r.content || '';
const combined = title + ' ' + content;
const url = r.url || '';

// Vérifier si c'est une annonce individuelle
const isIndividuelle = annoncePatterns.some(function(p) { return p.test(url); });

// Exclure sources non pertinentes
const isExcluded = excluded.some(function(ex) {
return url.toLowerCase().includes(ex) || title.toLowerCase().includes(ex);
});

if (isExcluded) continue;

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
if (val >= surfMin && val <= 2000) { surface = val; break; }
}

// Extraire prix total
let prix = 0;
const prixPatterns = [
/(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*€(?!\s*\/)/gi,
/(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*euros?(?!\s*\/m)/gi,
/(\d{3,4})\s*000\s*€/gi,
/prix\s*:?\s*(\d{1,3}(?:[\s\u00a0]\d{3})+)/gi
];
for (let p = 0; p < prixPatterns.length && prix === 0; p++) {
let m2;
prixPatterns[p].lastIndex = 0;
while ((m2 = prixPatterns[p].exec(combined)) !== null) {
const val = parseInt(m2[1].replace(/[\s\u00a0]/g, ''), 10);
if (val >= 50000 && val <= 50000000) { prix = val; break; }
}
}

// Déductions croisées
if (prix === 0 && prix_m2 > 0 && surface > 0) prix = Math.round(prix_m2 * surface);
if (prix_m2 === 0 && prix > 0 && surface > 0) prix_m2 = Math.round(prix / surface);

// Filtrer si pas de prix ET pas annonce individuelle confirmée
if (prix === 0 && prix_m2 === 0 && !isIndividuelle) continue;
if (prix === 0 && prix_m2 === 0) continue;

// Détecter source
let source = 'Autre';
if (url.includes('seloger.com')) source = 'SeLoger';
else if (url.includes('leboncoin.fr')) source = 'LeBonCoin';
else if (url.includes('pap.fr')) source = 'PAP';
else if (url.includes('notaires.fr')) source = 'Notaires';
else if (url.includes('bienici.com')) source = 'Bienici';

// Détecter type de bien
const lc = combined.toLowerCase();
let type = 'Appartement';
if (lc.includes('bureau')) type = 'Bureau';
else if (lc.includes('commerce') || lc.includes('boutique')) type = 'Commerce';
else if (lc.includes('atelier') || lc.includes('entrepôt')) type = 'Industriel';
else if (lc.includes('maison') || lc.includes('pavillon')) type = 'Maison';

annonces.push({
adresse: title.substring(0, 80),
ville: zone1,
surface: Math.round(surface),
prix: prix,
prix_m2: prix_m2,
type: type,
source: source,
description: content.substring(0, 200),
lien: url,
individuelle: isIndividuelle
});
}

// Trier : annonces individuelles en premier
annonces.sort(function(a, b) {
if (a.individuelle && !b.individuelle) return -1;
if (!a.individuelle && b.individuelle) return 1;
return 0;
});

return res.status(200).json({
content: [{ type: 'text', text: JSON.stringify({ annonces: annonces }) }]
});

} else {
// Agents 2-5 : Anthropic Claude
const groqMsgs = msgs.map(function(m) {
return {
role: m.role,
content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
};
});

// Détecter si c'est l'agent analyste marché (agent 2) pour enrichir avec DVF
const isAnalyste = groqMsgs.some(function(m) {
return m.content && m.content.includes('ACTIF') && m.content.includes('Prix acquisition');
});

let dvfData = '';
if (isAnalyste) {
// Extraire le code postal depuis le message
const cpMatch = groqMsgs[0] && groqMsgs[0].content.match(/Paris (\d+)e/i);
const cp = cpMatch ? '750' + (parseInt(cpMatch[1]) < 10 ? '0' + cpMatch[1] : cpMatch[1]) : '75016';
try {
const dvfRes = await fetch('https://api.prix-immo.io/ventes?code_postal=' + cp + '&type=Appartement&limit=10', {
headers: { 'Accept': 'application/json' }
});
if (dvfRes.ok) {
const dvfJson = await dvfRes.json();
dvfData = '\n\nDONNÉES DVF RÉELLES (ventes notariées) :\n' + JSON.stringify(dvfJson).substring(0, 500);
}
} catch (e) {
// DVF indisponible, on continue sans
}
}

// Injecter données DVF dans le prompt si disponible
if (dvfData && groqMsgs.length > 0) {
groqMsgs[groqMsgs.length - 1].content += dvfData;
}

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
