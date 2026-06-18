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

      const PORTALS = ['seloger.com', 'leboncoin.fr', 'pap.fr', 'bienici.com'];

      const zones = zonesRaw.split(',').map(function(z) { return z.trim(); });

      const queries = [];
      zones.forEach(function(zone) {
        queries.push(zone + ' appartement vente travaux rénover');
        queries.push(zone + ' immeuble local commercial bureau vente');
      });

      const allResults = [];

      for (let q = 0; q < queries.length; q++) {
        try {
          const tRes = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: TAVILY_KEY,
              query: queries[q],
              max_results: 7,
              search_depth: 'advanced',
              include_domains: PORTALS
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
        items.slice(0, 8).forEach(function(item) {
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

      // Extraction prix : uniquement valeurs entre 50 000 et 50 000 000
      // On exclut les séquences de plus de 8 chiffres (numéros de référence)
      function extractPrice(text) {
        // Pattern : nombre formaté avec espaces/points comme séparateurs de milliers
        // On cible spécifiquement les formats prix immobilier FR
        var patterns = [
          // "840 000 €" ou "840 000€"
          /\b(\d{1,3}(?:[\s\u00a0]\d{3}){1,2})\s*€/g,
          // "840000€" (collé, max 8 chiffres)
          /\b(\d{5,8})€/g,
          // "840.000 €"
          /\b(\d{1,3}(?:\.\d{3}){1,2})\s*€/g,
          // "prix : 840000"
          /prix\s*:?\s*(\d{5,8})\b/gi,
        ];
        for (var p = 0; p < patterns.length; p++) {
          var m;
          patterns[p].lastIndex = 0;
          while ((m = patterns[p].exec(text)) !== null) {
            var raw = m[1].replace(/[\s\u00a0\.]/g, '');
            // Rejeter si plus de 8 chiffres (= numéro de référence)
            if (raw.length > 8) continue;
            var val = parseInt(raw, 10);
            if (val >= 50000 && val <= 50000000) return val;
          }
        }
        return 0;
      }

      function extractSurface(text, min) {
        var regex = /(\d{1,4}(?:[,\.]\d{1,2})?)\s*m[²2]/gi;
        var m;
        while ((m = regex.exec(text)) !== null) {
          var val = parseFloat(m[1].replace(',', '.'));
          if (val >= min && val <= 5000) return val;
        }
        return 0;
      }

      function extractPrixM2(text) {
        var regex = /(\d{1,3}(?:[\s\u00a0]\d{3})?|\d{4,6})\s*[€e]\s*\/\s*m[²2]/gi;
        var m;
        while ((m = regex.exec(text)) !== null) {
          var val = parseInt(m[1].replace(/[\s\u00a0]/g, ''), 10);
          if (val >= 1000 && val <= 50000) return val;
        }
        return 0;
      }

      var annonces = [];

      for (var i = 0; i < unique.length; i++) {
        var r = unique[i];
        var title = r.title || '';
        var content = r.content || '';
        var url = r.url || '';
        var urlLower = url.toLowerCase();
        var combinedLower = (title + ' ' + content).toLowerCase();

        // Vérifier que l'URL vient bien d'un portail immobilier
        var isPortal = PORTALS.some(function(d) { return urlLower.includes(d); });
        if (!isPortal) continue;

        // Exclure location pure
        if ((urlLower.includes('/location') || combinedLower.startsWith('louer ')) && !urlLower.includes('vente')) continue;

        // Exclure contenu non-annonce (guides, articles)
        if (combinedLower.includes('überspringen')) continue;
        if (title.toLowerCase().includes('guide') || title.toLowerCase().includes('comment ')) continue;

        // Extraction
        var fullText = title + ' ' + content;
        var prix = extractPrice(title) || extractPrice(content.substring(0, 500));
        var surface = extractSurface(title, surfMin) || extractSurface(content.substring(0, 500), surfMin);
        var prix_m2 = extractPrixM2(fullText);

        // Déductions croisées
        if (prix === 0 && prix_m2 > 0 && surface > 0) prix = Math.round(prix_m2 * surface);
        if (prix_m2 === 0 && prix > 0 && surface > 0) prix_m2 = Math.round(prix / surface);

        // Valider prix/m² cohérent (Paris : 3000 à 30000)
        if (prix_m2 > 30000) prix_m2 = 0;
        if (prix_m2 > 0 && prix > 0 && (prix / prix_m2) < 5) { prix = 0; prix_m2 = 0; } // incohérent

        // Source
        var source = 'Web';
        if (urlLower.includes('seloger.com')) source = 'SeLoger';
        else if (urlLower.includes('leboncoin.fr')) source = 'LeBonCoin';
        else if (urlLower.includes('pap.fr')) source = 'PAP';
        else if (urlLower.includes('bienici.com')) source = 'Bienici';

        // Type
        var type = 'Appartement';
        if (combinedLower.includes('immeuble entier') || combinedLower.includes('immeuble de rapport')) type = 'Immeuble';
        else if (combinedLower.includes('bureau')) type = 'Bureau';
        else if (combinedLower.includes('commerce') || combinedLower.includes('local commercial')) type = 'Commerce';
        else if (combinedLower.includes('maison') || combinedLower.includes('pavillon')) type = 'Maison';
        else if (combinedLower.includes('loft') || combinedLower.includes('duplex') || combinedLower.includes('triplex')) type = 'Atypique';
        else if (combinedLower.includes('hôtel') && !combinedLower.includes('hôtel particulier')) type = 'Hôtel';

        annonces.push({
          adresse: title.substring(0, 80),
          ville: zones[0],
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
