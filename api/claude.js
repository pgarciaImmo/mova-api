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
const match = userContent.match(/Zones\s*:\s*([^\n]+)/i);
const zones = match ? match[1].trim() : 'Paris';

const tRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
api_key: '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',
query: 'appartement renover ' + zones + ' vente prix',
max_results: 8,
search_depth: 'basic'
})
});

const tData = await tRes.json();
const results = tData.results || [];
const annonces = [];

for (let i = 0; i < results.length; i++) {
const r = results[i];
annonces.push({
adresse: (r.title || '').substring(0, 80),
ville: zones.split(',')[0].trim(),
surface: 0,
prix: 0,
prix_m2: 0,
type: 'Appartement',
description: (r.content || '').substring(0, 150),
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

const gRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': 'Bearer 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'
},
body: JSON.stringify({
model: 'llama-3.3-70b-versatile',
max_tokens: body.max_tokens || 2000,
messages: groqMsgs
})
});

const gData = await gRes.json();
const text = gData.choices && gData.choices[0] ? gData.choices[0].message.content : 'Erreur.';
return res.status(200).json({ content: [{ type: 'text', text: text }] });
}

} catch (err) {
return res.status(500).json({ error: err.message });
}
}
