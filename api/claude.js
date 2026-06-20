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

      // Requêtes réduites à 3 pour limiter le volume de raw_content (perf/mémoire)
      const queries = [
        zone1 + ' appartement vente achat annonce ' + kwRenovation,
        zone1 + ' vente achat annonce ' + kwAtypique,
        zone2 + ' appartement vente achat annonce ' + kwRenovation
      ];

      const allResults = [];
      const debugQueryErrors = [];

      for (let q = 0; q < queries.length; q++) {
        try {
          const tRes = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: TAVILY_KEY,
              query: queries[q],
              max_results: 4,
              search_depth: 'advanced',
              include_raw_content: true
            })
          });
          const tData = await tRes.json();
          if (tData.results) allResults.push(...tData.results);
          else debugQueryErrors.push({ query: queries[q], response: tData });
        } catch (e) {
          debugQueryErrors.push({ query: queries[q], error: e.message });
        }
      }

      // PAP RSS (déjà annonces individuelles, pas besoin de raw_content)
      try {
        const papRss = await fetch('https://www.pap.fr/rss/annonces-ventes-immobilieres.rss?geo=r159&type=appartement');
        const papText = await papRss.text();
        const items = papText.match(/<item>([\s\S]*?)<\/item>/g) || [];
        items.slice(0, 6).forEach(function(item) {
          const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || '';
          const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
          const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || [])[1] || '';
          if (title && link) allResults.push({ title: title, url: link, content: desc, isIndividual: true });
        });
      } catch (e) {}

      // Fonction pour extraire prix dans un contexte de texte limité (fenêtre autour d'une position)
      function extractPriceNear(text, pos, windowSize) {
        var start = Math.max(0, pos - windowSize);
        var end = Math.min(text.length, pos + windowSize);
        var snippet = text.substring(start, end);
        var patterns = [
          /(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*€/,
          /(\d{1,3}(?:\.\d{3})+)\s*€/,
          /([1-9]\d{5,7})\s*€/
        ];
        for (var p = 0; p < patterns.length; p++) {
          var m = snippet.match(patterns[p]);
          if (m) {
            var val = parseInt(m[1].replace(/[\s\u00a0\.]/g, ''), 10);
            if (val >= 50000 && val <= 100000000) return val;
          }
        }
        return 0;
      }

      function extractSurfaceNear(text, pos, windowSize, minSurf) {
        var start = Math.max(0, pos - windowSize);
        var end = Math.min(text.length, pos + windowSize);
        var snippet = text.substring(start, end);
        var m = snippet.match(/(\d{1,4}(?:[,\.]\d{1,2})?)\s*m[²2]/);
        if (m) {
          var val = parseFloat(m[1].replace(',', '.'));
          if (val >= minSurf && val <= 5000) return val;
        }
        return 0;
      }

      const annonces = [];
      const seenUrls = {};

      // PATTERNS pour détecter des liens d'annonces individuelles dans le HTML brut
      const annoncePatterns = [
        /href=["']([^"']*seloger\.com\/annonces\/\d+[^"']*)["']/gi,
        /href=["']([^"']*leboncoin\.fr\/[^"']*ventes_immobilieres\/\d+[^"']*)["']/gi,
        /href=["']([^"']*bienici\.com\/annonce[^"']*)["']/gi,
        /href=["']([^"']*logic-immo\.com\/[^"']*ad\d+[^"']*)["']/gi
      ];

      // DEBUG: capture la forme brute des 2 premiers résultats pour diagnostic
      const debugSamples = allResults.slice(0, 2).map(function(r) {
        return {
          url: r.url || '',
          title: r.title || '',
          raw_content_length: (r.raw_content || '').length,
          raw_content_sample: (r.raw_content || r.content || '').substring(0, 800),
          has_href_tags: /href=/i.test(r.raw_content || ''),
          has_html_tags: /<[a-z]+[\s>]/i.test(r.raw_content || '')
        };
      });

      for (let i = 0; i < allResults.length; i++) {
        const r = allResults[i];
        const title = r.title || '';
        const url = r.url || '';
        const rawContent = r.raw_content || r.content || '';
        const titleLower = title.toLowerCase();
        const urlLower = url.toLowerCase();

        // EXCLURE domaines non pertinents
        const excludedDomains = ['cbre.fr', 'jll.fr', 'bnpparibas-realestate.com', 'valuo.fr', 'youtube.com', 'youtu.be'];
        if (excludedDomains.some(function(d) { return urlLower.includes(d); })) continue;
        if (rawContent.includes('Navigation überspringen')) continue;
        if (titleLower.includes('formation') || titleLower.includes('comment devenir')) continue;
        if ((urlLower.includes('/location') || titleLower.startsWith('louer ') || titleLower.startsWith('location ')) && !urlLower.includes('vente') && !titleLower.includes('vente') && !titleLower.includes('achat')) continue;

        // Si c'est déjà une annonce individuelle (PAP, ou URL avec ID numérique direct)
        const isDirectAnnonce = r.isIndividual ||
          /seloger\.com\/annonces\/\d+/.test(urlLower) ||
          /leboncoin\.fr\/.*ventes_immobilieres\/\d+/.test(urlLower) ||
          /pap\.fr\/annonce\//.test(urlLower);

        if (isDirectAnnonce) {
          if (seenUrls[url]) continue;
          seenUrls[url] = true;

          let prix = extractPriceNear(title + ' ' + rawContent, 0, 500) || extractPriceNear(rawContent, 0, 300);
          let surface = extractSurfaceNear(title + ' ' + rawContent, 0, 500, surfMin) || extractSurfaceNear(rawContent, 0, 300, surfMin);

          if (prix === 0 && surface === 0) continue;

          let prix_m2 = (prix > 0 && surface > 0) ? Math.round(prix / surface) : 0;

          const combinedLower = (title + ' ' + rawContent).toLowerCase();
          let type = 'Appartement';
          if (combinedLower.includes('bureau')) type = 'Bureau';
          else if (combinedLower.includes('commerce') || combinedLower.includes('local commercial')) type = 'Commerce';
          else if (combinedLower.includes('maison')) type = 'Maison';
          else if (combinedLower.includes('loft') || combinedLower.includes('duplex')) type = 'Atypique';

          let source = 'Web';
          if (urlLower.includes('seloger.com')) source = 'SeLoger';
          else if (urlLower.includes('leboncoin.fr')) source = 'LeBonCoin';
          else if (urlLower.includes('pap.fr')) source = 'PAP';

          annonces.push({
            adresse: title.substring(0, 80),
            ville: zone1,
            surface: surface > 0 ? Math.round(surface) : null,
            prix: prix > 0 ? prix : null,
            prix_m2: prix_m2 > 0 ? prix_m2 : null,
            type: type,
            source: source,
            description: rawContent.substring(0, 250),
            lien: url
          });
          continue;
        }

        // Sinon, c'est probablement une page de liste : extraire les annonces individuelles du HTML brut
        let foundIndividual = false;
        for (let p = 0; p < annoncePatterns.length; p++) {
          annoncePatterns[p].lastIndex = 0;
          let m;
          let count = 0;
          while ((m = annoncePatterns[p].exec(rawContent)) !== null && count < 5) {
            const annonceUrl = m[1];
            if (seenUrls[annonceUrl]) continue;
            seenUrls[annonceUrl] = true;
            foundIndividual = true;
            count++;

            const pos = m.index;
            const prix = extractPriceNear(rawContent, pos, 400);
            const surface = extractSurfaceNear(rawContent, pos, 400, surfMin);
            if (prix === 0 && surface === 0) continue;

            const prix_m2 = (prix > 0 && surface > 0) ? Math.round(prix / surface) : 0;
            let source = 'Web';
            if (annonceUrl.includes('seloger.com')) source = 'SeLoger';
            else if (annonceUrl.includes('leboncoin.fr')) source = 'LeBonCoin';
            else if (annonceUrl.includes('bienici.com')) source = 'Bienici';
            else if (annonceUrl.includes('logic-immo.com')) source = 'Logic-Immo';

            annonces.push({
              adresse: 'Annonce ' + source + ' (' + zone1 + ')',
              ville: zone1,
              surface: surface > 0 ? Math.round(surface) : null,
              prix: prix > 0 ? prix : null,
              prix_m2: prix_m2 > 0 ? prix_m2 : null,
              type: 'Appartement',
              source: source,
              description: rawContent.substring(Math.max(0, pos - 100), pos + 200),
              lien: annonceUrl
            });
          }
        }

        // Si aucune annonce individuelle trouvée dans cette page, on garde la page elle-même en dernier recours
        if (!foundIndividual && !seenUrls[url]) {
          seenUrls[url] = true;
          const prix = extractPriceNear(title + ' ' + rawContent, 0, 500);
          const surface = extractSurfaceNear(title + ' ' + rawContent, 0, 500, surfMin);
          if (prix > 0 || surface > 0) {
            const prix_m2 = (prix > 0 && surface > 0) ? Math.round(prix / surface) : 0;
            let source = 'Web';
            if (urlLower.includes('seloger.com')) source = 'SeLoger';
            else if (urlLower.includes('etreproprio.com')) source = 'EtreProprio';
            else if (urlLower.includes('superimmo.com')) source = 'SuperImmo';
            annonces.push({
              adresse: title.substring(0, 80),
              ville: zone1,
              surface: surface > 0 ? Math.round(surface) : null,
              prix: prix > 0 ? prix : null,
              prix_m2: prix_m2 > 0 ? prix_m2 : null,
              type: 'Appartement',
              source: source,
              description: rawContent.substring(0, 250),
              lien: url
            });
          }
        }
      }

      return res.status(200).json({
        content: [{
          type: 'text',
          text: JSON.stringify({
            annonces: annonces,
            _debug: {
              total_results_fetched: allResults.length,
              query_errors: debugQueryErrors,
              samples: debugSamples
            }
          })
        }]
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
    return res.status(500).json({
      content: [{ type: 'text', text: 'Erreur: ' + err.message }]
    });
  }
};
