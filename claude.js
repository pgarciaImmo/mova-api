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
const surfMatch = userMsg.match(/Surface min\s*:\s*(\d+)/i);
const zones = zonesMatch ? zonesMatch[1].trim() : 'Versailles';
const surf = surfMatch ? surfMatch[1] : '17';

const tavilyRes = await fetch('https://api.tavily.com/search', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
api_key: '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',
query: 'appartement renover ' + zones + ' immobilier prix',
max_results: 10,
search_depth: 'basic'
})
});

const tavilyData = await tavilyRes.json();

if (!tavilyData.results || tavilyData.results.length === 0) {
const errMsg = JSON.stringify(tavilyData).replace(/"/g, "'");
return res.status(200).json({
content: [{ type: 'text', text: '{"annonces":[],"debug":"Tavily: ' + errMsg + '"}' }]
});
}

const context = tavilyData.results.map(r => 'TITRE: ' + r.title + '\nURL: ' + r.url + '\nCONTENU: ' + r.content).join('\n\n---\n\n');

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
content: 'Tu es chasseur immobilier. Extrait les annonces des resultats de recherche. Reponds UNIQUEMENT en JSON valide sans backticks : {"annonces":[{"adresse":"adresse","ville":"ville","surface":XX,"prix":XXXXXX,"prix_m2":XXXX,"type":"Appartement","description":"description courte","lien":"url"}]}. Si aucune annonce concrete, mets tableau vide.'
},
{
role: 'user',
content: 'Zone: ' + zones + ', surface min: ' + surf + 'm2\n\n' + context
}
]
})
});

const groqData = await groqRes.json();
const text = groqData.choices?.[0]?.message?.content || '{"annonces":[],"debug":"Groq vide"}';
return res.status(200).json({ content: [{ type: 'text', text }] });

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
