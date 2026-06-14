export default async function handler(req, res) {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
if (req.method === 'OPTIONS') return res.status(200).end();
if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

try {
const body = req.body;
const isChasseur = body.tools && body.tools.some(t => t.type === 'web_search_20250305');

if (isChasseur) {
// Extraire zones et surface du message
const userMsg = body.messages?.[0]?.content || '';
const zonesMatch = userMsg.match(/Zones\s*:\s*([^\n]+)/i);
const surfMatch = userMsg.match(/Surface min\s*:\s*(\d+)/i);
const zones = zonesMatch ? zonesMatch[1].trim() : 'Paris';
const surf = surfMatch ? surfMatch[1] : '17';

// Construire plusieurs requêtes Tavily ciblées
const queries = [
`appartement à rénover ${zones} site:seloger.com`,
`vente urgente succession travaux ${zones} site:leboncoin.fr`,
`appartement travaux ${zones} prix négociable site:pap.fr`
];

let allResults = [];
for (const query of queries) {
try {
const tavilyRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
api_key: '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',
query: query,
max_results: 5,
search_depth: 'basic'
})
});
const tavilyData = await tavilyRes.json();
if (tavilyData.results) allResults = allResults.concat(tavilyData.results);
} catch(e) {}
}

const context = allResults.map(r => `TITRE: ${r.title}\nURL: ${r.url}\nCONTENU: ${r.content}`).join('\n\n---\n\n');

const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': 'Bearer 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'
},
body: JSON.stringify({
model: 'llama-3.3-70b-versatile',
max_tokens: 4000,
messages: [
{
role: 'system',
content: 'Tu es chasseur immobilier pour un marchand de biens Paris Île-de-France. A partir des résultats de recherche fournis, extrait les annonces immobilières et réponds UNIQUEMENT en JSON valide sans backticks ni markdown, format exact : {"annonces":[{"adresse":"adresse complète","ville":"ville ou arrondissement","surface":XX,"prix":XXXXXX,"prix_m2":XXXX,"type":"Appartement ou Maison ou Immeuble","description":"état et caractéristiques clés en 1 ligne","lien":"url de annonce"}]}. Si prix inconnu mets 0. Trie par prix_m2 croissant. Max 12 annonces.'
},
{
role: 'user',
content: `Zones recherchées : ${zones}, surface min : ${surf}m²\n\nRésultats de recherche :\n\n${context}`

}
]
})
});

const groqData = await groqRes.json();
const text = groqData.choices?.[0]?.message?.content || '{"annonces":[]}';
return res.status(200).json({ content: [{ type: 'text', text }] });

} else {
// AGENTS 2-3-4-5 — Groq
const messages = body.messages || [];
const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': 'Bearer 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'
},
body: JSON.stringify({
model: 'llama-3.3-70b-versatile',
max_tokens: body.max_tokens || 2000,
messages: messages.map(m => ({
role: m.role,
content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}))
})
});
const groqData = await groqRes.json();
const text = groqData.choices?.[0]?.message?.content || 'Erreur de génération.';
return res.status(200).json({ content: [{ type: 'text', text }] });
}

} catch (error) {
return res.status(500).json({ error: error.message });
}
}
