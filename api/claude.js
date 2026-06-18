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

      const kwRenovation = 'rénover OR travaux OR succession OR liquidation OR rafraîchir OR restructurer OR squatté';
      const kwAtypique = 'atypique OR loft OR duplex OR hôtel OR commercialité OR immeuble OR bureau OR atelier OR Haussmannien';

      const zones = zonesRaw.split(',').map(function(z) { return z.trim(); });
      const zone1 = zones[0];
      const zone2 = zones[1] || zones[0];

      const queries = [
        zone1 + ' appartement vente achat annonce ' + kwRenovation,
        zone1 + ' vente achat annonce ' + kwAtypique,
        zone2 + ' appartement vente achat annonce ' + kwRenovation,
        zone1 + ' local commercial bureau immeuble vente achat annonce prix euros'
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
        const papRss = await fetch('https://www.pap.fr/rss/annonces-ventes-immobilieres.rss?geo=r159&type=appartement');
        const papText = await papRss.text();
        const items = papText.match(/<item>([\s\S]*?)<\/item>/g) || [];
        items.slice(0, 6).forEach(function(item) {
          const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || '';
          const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
          const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || [])[1] || '';
          if (title && link) allResults.push({ title: title, url: link, content: desc });
        });
      } catch (e) {}

      // Dédoublonnage
      const seen = {};
      const unique = allResults.filter(function(r) {
        if (!r.url || seen[r.url]) return false;
        seen[r.url] = true;
        return true;
      });

      // Fonction pour extraire TOUS les prix d'un texte
      function extractAllPrices(text) {
        var prices = [];
        var patterns = [
          /(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*€/gi,
          /(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*euros?/gi,
          /(\d{6,8})€/gi,
          /(\d{1,3}(?:\.\d{3})+)\s*€/gi,
          /prix\s*:?\s*(\d{5,8})/gi
        ];
        for (var p = 0; p < patterns.length; p++) {
          var m;
          patterns[p].lastIndex = 0;
          while ((m = patterns[p].exec(text)) !== null) {
            var val = parseInt(m[1].replace(/[\s\u00a0\.]/g, ''), 10);
            if (val >= 50000) prices.push(val);
          }
        }
        return prices;
      }

      // Fonction pour extraire TOUTES les surfaces
      function extractAllSurfaces(text, min) {
        var surfaces = [];
        var regex = /(\d{1,4}(?:[,\.]\d{1,2})?)\s*m[²2]/gi;
        var m;
        while ((m = regex.exec(text)) !== null) {
          var val = parseFloat(m[1].replace(',', '.'));
          if (val >= min && val <= 5000) surfaces.push(val);
        }
        return surfaces;
      }

      var annonces = [];

      for (var i = 0; i < unique.length; i++) {
        var r = unique[i];
        var title = r.title || '';
        var content = r.content || '';
        var url = r.url || '';
        var urlLower = url.toLowerCase();
        var titleLower = title.toLowerCase();
        var combinedLower = (title + ' ' + content).toLowerCase();

        // EXCLURE domaines non pertinents
        var excludedDomains = ['cbre.fr', 'jll.fr', 'bnpparibas-realestate.com', 'valuo.fr', 'youtube.com', 'youtu.be'];
        if (excludedDomains.some(function(d) { return urlLower.includes(d); })) continue;

        // EXCLURE titres en anglais ou formations
        if (titleLower.includes('formation') || titleLower.includes('comment devenir')) continue;

        // EXCLURE location pure
        if ((urlLower.includes('/location') || titleLower.startsWith('louer ') || titleLower.startsWith('location ')) && !urlLower.includes('vente') && !titleLower.includes('vente') && !titleLower.includes('achat')) continue;

        // Extraire prix depuis le TITRE en priorité, puis le début du content
        var titlePrices = extractAllPrices(title);
        var contentPrices = extractAllPrices(content.substring(0, 300)); // Seulement les 300 premiers caractères
        
        // Prendre le prix du titre si disponible, sinon premier prix du début du content
        var prix = 0;
        if (titlePrices.length > 0) {
          prix = titlePrices[0];
        } else if (contentPrices.length > 0) {
          prix = contentPrices[0];
        }

        // Extraire surface depuis le titre en priorité
        var titleSurfaces = extractAllSurfaces(title, surfMin);
        var contentSurfaces = extractAllSurfaces(content.substring(0, 300), surfMin);
        var surface = titleSurfaces.length > 0 ? titleSurfaces[0] : (contentSurfaces.length > 0 ? contentSurfaces[0] : 0);

        // Prix au m²
        var prix_m2 = 0;
        var pm2Regex = /(\d{1,3}(?:[\s\u00a0]\d{3})*|\d{4,6})\s*[€e]\s*\/\s*m[²2]/gi;
        var pm;
        var combined300 = title + ' ' + content.substring(0, 300);
        while ((pm = pm2Regex.exec(combined300)) !== null) {
          var val = parseInt(pm[1].replace(/[\s\u00a0]/g, ''), 10);
          if (val >= 1000 && val <= 50000) { prix_m2 = val; break; }
        }

        // Déductions croisées
        if (prix === 0 && prix_m2 > 0 && surface > 0) prix = Math.round(prix_m2 * surface);
        if (prix_m2 === 0 && prix > 0 && surface > 0) prix_m2 = Math.round(prix / surface);

        // Source
        var source = 'Web';
        if (urlLower.includes('seloger.com')) source = 'SeLoger';
        else if (urlLower.includes('leboncoin.fr')) source = 'LeBonCoin';
        else if (urlLower.includes('pap.fr')) source = 'PAP';
        else if (urlLower.includes('notaires.fr')) source = 'Notaires';
        else if (urlLower.includes('bienici.com')) source = 'Bienici';
        else if (urlLower.includes('logic-immo.com')) source = 'Logic-Immo';
        else if (urlLower.includes('etreproprio.com')) source = 'EtreProprio';
        else if (urlLower.includes('bureauxlocaux.com')) source = 'BureauxLocaux';
        else if (urlLower.includes('superimmo.com')) source = 'SuperImmo';

        // Type
        var type = 'Appartement';
        if (combinedLower.includes('immeuble entier') || combinedLower.includes('immeuble de rapport')) type = 'Immeuble';
        else if (combinedLower.includes('bureau')) type = 'Bureau';
        else if (combinedLower.includes('commerce') || combinedLower.includes('boutique') || combinedLower.includes('local commercial')) type = 'Commerce';
        else if (combinedLower.includes('atelier') || combinedLower.includes('entrepôt')) type = 'Industriel';
        else if (combinedLower.includes('maison') || combinedLower.includes('pavillon')) type = 'Maison';
        else if (combinedLower.includes('hôtel') && !combinedLower.includes('hôtel particulier')) type = 'Hôtel';
        else if (combinedLower.includes('loft') || combinedLower.includes('duplex') || combinedLower.includes('triplex')) type = 'Atypique';

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
      var groqMsgs = msgs.map(function(m) {
        return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      });

      var cRes = await fetch('https://api.anthropic.com/v1/messages', {
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

      var cData = await cRes.json();
      var text = cData.content && cData.content[0] ? cData.content[0].text : 'Erreur de génération';

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
