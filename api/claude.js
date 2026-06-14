export default async function handler(req, res) {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
if (req.method === 'OPTIONS') return res.status(200).end();
if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

try {
const body = req.body;
const isChasseur = body.tools && Array.isArray(body.tools) && body.tools.some(function(t) { return t.type === 'web_search_20250305'; });

if (isChasseur) {
const messages = body.messages || [];
const userContent = messages[0] ? messages[0].content : '';
const zonesMatch = userContent.match(/Zones\s*:\s*([^\n]+)/i);
const zones = zonesMatch ? zonesMatch[1].trim() : 'Paris';

const tavilyBody = JSON.stringify({
api_key: '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',
query: 'appartement renover ' + zones + ' vente prix',
max_results: 8,
search_depth: 'basic'
});

const tavilyRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: tavilyBody
});

const tavilyData = await tavilyRes.json();
const results = tavilyData.results || [];

const annonces = [];
for (var i = 0; i < results.length; i++) {
var r = results[i];
var title = r.title || '';
var url = r.url || '';
var content = r.content || '';

var prixMatch = content.match(/(\d[\d ]{2,8})\s*EUR/i) || content.match(/(\d[\d ]{2,8})\s*euro/i) || content.match(/(\d[\d ]{2,8})\s*\u20ac/);
var prix = 0;
if (prixMatch) {
prix = parseInt(prixMatch[1].replace(/ /g, '')) || 0;
}

var surfMatch = content.match(/(\d+)\s*m2/i) || content.match(/(\d+)\s*m\u00b2/);
var surface = surfMatch ? parseInt(surfMatch[1]) : 0;

var prix_m2 = (prix > 0 && surface > 0) ? Math.round(prix / surface) : 0;

annonces.push({
adresse: title.substring(0, 80),
ville: zones.split(',')[0].trim(),
surface: surface,
prix: prix,
prix_m2: prix_m2,
type: 'Appartement',
description: content.substring(0, 150),
lien: url
});
}

return res.status(200).json({
content: [{ type: 'text', text: JSON.stringify({ annonces: annonces }) }]
});

} else {
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
messages: messages.map(function(m) {
return {
role: m.role,
content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
};
})
})
});
const groqData = await groqRes.json();
const text = (groqData.choices && groqData.choices[0] && groqData.choices[0].message) ? groqData.choices[0].message.content : 'Erreur.';
return res.status(200).json({ content: [{ type: 'text', text: text }] });

}

} catch (error) {
return res.status(500).json({ error: error.message });
}
}


Le dim. 14 juin 2026 à 18:54, PAULO GARCIA <pgarcia.immo@gmail.com> a écrit :
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
const userMsg = body.messages?.[0]?.content || '';
const zonesMatch = userMsg.match(/Zones\s*:\s*([^\n]+)/i);
const zones = zonesMatch ? zonesMatch[1].trim() : 'Paris';

const tavilyRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
api_key: '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',
query: 'appartement renover ' + zones + ' vente prix immobilier',
max_results: 10,
search_depth: 'basic',
include_answer: true
})
});

const tavilyData = await tavilyRes.json();
const results = tavilyData.results || [];

if (results.length === 0) {
return res.status(200).json({
content: [{ type: 'text', text: '{"annonces":[],"debug":"Tavily 0 resultats: ' + JSON.stringify(tavilyData).substring(0,200) + '"}' }]
});
}

// Construire annonces directement depuis Tavily sans passer par Groq
const annonces = results.slice(0, 10).map((r, i) => {
const title = r.title || '';
const url = r.url || '';
const content = r.content || '';

// Extraire prix
const prixMatch = content.match(/(\d[\d\s]{2,8})\s*[€eur]/i) || title.match(/(\d[\d\s]{2,8})\s*[€eur]/i);
const prixStr = prixMatch ? prixMatch[1].replace(/\s/g, '') : '0';
const prix = parseInt(prixStr) || 0;

// Extraire surface
const surfMatch = content.match(/(\d+)\s*m[²2]/i) || title.match(/(\d+)\s*m[²2]/i);
const surface = surfMatch ? parseInt(surfMatch[1]) : 0;

const prix_m2 = (prix > 0 && surface > 0) ? Math.round(prix / surface) : 0;

// Extraire ville/adresse du titre
const adresse = title.substring(0, 60);

return {
adresse: adresse,
ville: zones.split(',')[0].trim(),
surface: surface,
prix: prix,
prix_m2: prix_m2,
type: 'Appartement',
description: content.substring(0, 120),
lien: url
};
}).filter(a => a.lien);

return res.status(200).json({
content: [{ type: 'text', text: JSON.stringify({ annonces: annonces }) }]

});

} else {
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
const text = groqData.choices?.[0]?.message?.content || 'Erreur de generation.';
return res.status(200).json({ content: [{ type: 'text', text }] });
}

} catch (error) {
return res.status(200).json({
content: [{ type: 'text', text: '{"annonces":[],"debug":"Exception: ' + error.message + '"}' }]
});
}
}
