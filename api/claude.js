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

      const TAVILY_KEY = process.env.TAVILY_API_KEY;

      const kwRenovation = 'rénover OR travaux OR succession OR liquidation OR rafraîchir OR restructurer OR squatté OR vétusté OR indivision OR mutation';
      const kwAtypique = 'atypique OR loft OR duplex OR hôtel OR commercialité OR immeuble OR bureau OR atelier OR Haussmannien OR entrepôt OR commerce OR mur commercial OR local commercial';

      const zones = zonesRaw.split(',').map(function(z) { return z.trim(); }).filter(Boolean);
      const zone1 = zones[0] || 'Paris 16e';

      // Pour chaque zone demandée, on lance 3 requêtes (appartement / maison / bien commercial)
      // plutôt qu'une seule requête par zone. Avant, une seule requête par zone forçait un choix
      // de type de bien par zone (donc certaines zones ne voyaient jamais de maison, par ex.) ;
      // ici chaque zone est couverte sur les 3 familles, quitte à faire plus de requêtes Tavily.
      const bienTerms = [
        'appartement',
        'maison',
        'bureau OR local commercial OR commerce OR entrepôt OR immeuble'
      ];
      const queries = [];
      const queryZones = [];
      for (let zi = 0; zi < zones.length; zi++) {
        for (let bi = 0; bi < bienTerms.length; bi++) {
          const kw = (bi % 2 === 0) ? kwRenovation : kwAtypique;
          queries.push(zones[zi] + ' ' + bienTerms[bi] + ' vente achat annonce ' + kw);
          queryZones.push(zones[zi]);
        }
      }

      const allResults = [];

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
          if (tData.results) {
            tData.results.forEach(function(r) { r._zone = queryZones[q]; });
            allResults.push(...tData.results);
          }
        } catch (e) {}
      }

      // PAP RSS (déjà annonces individuelles, pas besoin de raw_content).
      // Avant : un seul flux filtré type=appartement -> aucune maison ne pouvait jamais
      // remonter de cette source. On interroge maintenant aussi le flux "maison".
      // Pour la zone : le flux PAP est global Île-de-France (non filtrable par ville précise
      // dans l'URL), donc on essaie de détecter la zone réelle dans le titre de l'annonce
      // (qui mentionne presque toujours la ville) plutôt que de tout étiqueter sur zone1.
      function detectZoneFromText(text, zonesList, fallback) {
        // Normalise "16ème"/"16eme"/"16e" en "16e" pour matcher peu importe l'orthographe utilisée
        const normalize = (s) => s.toLowerCase().replace(/(\d+)\s*(ème|eme|e)\b/g, '$1e');
        const textNorm = normalize(text);
        for (let zi = 0; zi < zonesList.length; zi++) {
          if (textNorm.includes(normalize(zonesList[zi]))) return zonesList[zi];
        }
        return fallback;
      }

      const papTypes = ['appartement', 'maison'];
      for (let pt = 0; pt < papTypes.length; pt++) {
        try {
          const papRss = await fetch('https://www.pap.fr/rss/annonces-ventes-immobilieres.rss?geo=r159&type=' + papTypes[pt]);
          const papText = await papRss.text();
          const items = papText.match(/<item>([\s\S]*?)<\/item>/g) || [];
          items.slice(0, 6).forEach(function(item) {
            const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || '';
            const link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
            const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || [])[1] || '';
            const detectedZone = detectZoneFromText(title + ' ' + desc, zones, zone1);
            if (title && link) allResults.push({ title: title, url: link, content: desc, isIndividual: true, _zone: detectedZone });
          });
        } catch (e) {}
      }

      // Fonction pour extraire prix dans un contexte de texte limité (fenêtre autour d'une position)
      // NB: on n'accepte que des nombres écrits avec séparateurs de milliers (espace ou point),
      // format standard d'un prix immobilier FR. Le pattern brut (6-8 chiffres collés à un €)
      // a été retiré : il capturait des n° de référence, codes, ou nombres de mise en page
      // qui se trouvaient near un € par coïncidence, ce qui faussait massivement les prix extraits.
      function extractPriceNear(text, pos, windowSize) {
        var start = Math.max(0, pos - windowSize);
        var end = Math.min(text.length, pos + windowSize);
        var snippet = text.substring(start, end);
        var patterns = [
          /(?:^|\D)(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*€/,
          /(?:^|\D)(\d{1,3}(?:\.\d{3})+)\s*€/
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

      // Trouve TOUTES les occurrences de prix dans un texte (HTML ou texte nettoyé, peu importe)
      function findAllPrices(text) {
        // Pattern fiable : nombre avec séparateur de milliers (espace, nbsp, ou point) suivi de €.
        // (?:^|\D) évite de capturer la fin d'un nombre plus long comme un nouveau prix.
        const reliablePatterns = [
          /(?:^|\D)(\d{1,3}(?:[\s\u00a0]\d{3})+)\s*€/g,
          /(?:^|\D)(\d{1,3}(?:\.\d{3})+)\s*€/g
        ];
        const found = [];
        for (let p = 0; p < reliablePatterns.length; p++) {
          let m;
          reliablePatterns[p].lastIndex = 0;
          while ((m = reliablePatterns[p].exec(text)) !== null) {
            const val = parseInt(m[1].replace(/[\s\u00a0\.]/g, ''), 10);
            if (val >= 50000 && val <= 100000000) {
              const numStart = m.index + m[0].indexOf(m[1]);
              found.push({ value: val, index: numStart, length: m[1].length });
            }
          }
        }
        found.sort(function(a, b) { return a.index - b.index; });
        const dedup = [];
        for (let i = 0; i < found.length; i++) {
          if (dedup.length === 0 || found[i].index - dedup[dedup.length - 1].index > 5) {
            dedup.push(found[i]);
          }
        }
        // Fallback : si AUCUN prix fiable trouvé sur toute la page, on tente le pattern brut
        // (6-8 chiffres collés à €) en dernier recours seulement — jamais mélangé aux prix
        // fiables, pour ne pas polluer une page qui a déjà de bons résultats avec du bruit.
        if (dedup.length === 0) {
          const rawPattern = /(?:^|\D)([1-9]\d{5,7})\s*€/g;
          let m;
          while ((m = rawPattern.exec(text)) !== null) {
            const val = parseInt(m[1], 10);
            if (val >= 50000 && val <= 100000000) {
              const numStart = m.index + m[0].indexOf(m[1]);
              dedup.push({ value: val, index: numStart, length: m[1].length });
            }
          }
        }
        return dedup;
      }

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
          if (/\bmaison\b/.test(combinedLower)) type = 'Maison';
          else if (/\b(loft|duplex)\b/.test(combinedLower) && !/\bappartement\b/.test(combinedLower)) type = 'Atypique';
          else if (/\bappartement\b/.test(combinedLower)) type = 'Appartement';
          else if (/\bbureau(x)?\b/.test(combinedLower)) type = 'Bureau';
          else if (/\b(local commercial|commerce)\b/.test(combinedLower)) type = 'Commerce';
          else if (/\b(entrepôt|entrepot)\b/.test(combinedLower)) type = 'Entrepôt';
          else if (/\bimmeuble\b/.test(combinedLower)) type = 'Immeuble';

          let source = 'Web';
          if (urlLower.includes('seloger.com')) source = 'SeLoger';
          else if (urlLower.includes('leboncoin.fr')) source = 'LeBonCoin';
          else if (urlLower.includes('pap.fr')) source = 'PAP';

          annonces.push({
            adresse: title.substring(0, 80),
            ville: detectZoneFromText(title + ' ' + rawContent, zones, r._zone || zone1),
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

        // Sinon, c'est une page qui peut contenir PLUSIEURS annonces : on segmente
        // le texte autour de chaque prix trouvé, qu'il y ait du HTML ou pas.
        if (seenUrls[url]) continue;

        const prices = findAllPrices(rawContent);

        let source = 'Web';
        if (urlLower.includes('seloger.com')) source = 'SeLoger';
        else if (urlLower.includes('leboncoin.fr')) source = 'LeBonCoin';
        else if (urlLower.includes('bienici.com')) source = 'Bienici';
        else if (urlLower.includes('logic-immo.com')) source = 'Logic-Immo';
        else if (urlLower.includes('etreproprio.com')) source = 'EtreProprio';
        else if (urlLower.includes('superimmo.com')) source = 'SuperImmo';

        if (prices.length === 0) {
          // Pas de prix du tout sur cette page : on tente quand même via surface + titre,
          // en dernier recours, pour ne pas perdre l'info si elle existe ailleurs.
          const surface = extractSurfaceNear(title + ' ' + rawContent, 0, 500, surfMin);
          if (surface > 0) {
            seenUrls[url] = true;
            annonces.push({
              adresse: title.substring(0, 80),
              ville: detectZoneFromText(title + ' ' + rawContent, zones, r._zone || zone1),
              surface: Math.round(surface),
              prix: null,
              prix_m2: null,
              type: 'Appartement',
              source: source,
              description: rawContent.substring(0, 250),
              lien: url
            });
          }
          continue;
        }

        seenUrls[url] = true;
        const maxPerPage = 5;
        for (let pIdx = 0; pIdx < Math.min(prices.length, maxPerPage); pIdx++) {
          const priceHit = prices[pIdx];
          const prix = priceHit.value;
          const surface = extractSurfaceNear(rawContent, priceHit.index, 350, surfMin);
          const prix_m2 = (prix > 0 && surface > 0) ? Math.round(prix / surface) : 0;

          const segStart = Math.max(0, priceHit.index - 150);
          const segEnd = Math.min(rawContent.length, priceHit.index + 250);
          const segment = rawContent.substring(segStart, segEnd);

          // Nettoyage : retire syntaxe markdown d'image ![alt](url), URLs brutes,
          // et chemins de fichiers (catalog/images/...), qui polluent l'extraction d'adresse.
          const segmentClean = segment
            .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
            .replace(/\]\([^)]*\)/g, ' ')
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/(?:\.\.\/)?[\w-]+\/[\w./-]*\.(?:jpg|jpeg|png|gif|webp)\)?/gi, ' ')
            .replace(/[\w-]*\.(?:html|htm|php)\b/gi, ' ')
            .replace(/\bREF\s*\d+[A-Z]?\s*#+/gi, ' ')
            .replace(/#{2,}/g, ' ')
            .replace(/^\s*(jpg|jpeg|png|gif|webp)\)?\s*/i, ' ')
            .replace(/[*"]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const segmentLower = segmentClean.toLowerCase();

          // Détection de type : priorité à "appartement"/"maison" explicites,
          // car "commerce" ou "bureau" peuvent apparaître par bruit (mentions d'honoraires, etc.)
          let type = 'Appartement';
          if (/\bmaison\b/.test(segmentLower)) type = 'Maison';
          else if (/\b(loft|duplex)\b/.test(segmentLower) && !/\bappartement\b/.test(segmentLower)) type = 'Atypique';
          else if (/\bappartement\b/.test(segmentLower)) type = 'Appartement';
          else if (/\bbureau(x)?\b/.test(segmentLower)) type = 'Bureau';
          else if (/\b(local commercial|commerce)\b/.test(segmentLower)) type = 'Commerce';
          else if (/\b(entrepôt|entrepot)\b/.test(segmentLower)) type = 'Entrepôt';
          else if (/\bimmeuble\b/.test(segmentLower)) type = 'Immeuble';

          // L'adresse extraite du texte brut autour du prix est peu fiable (slugs d'URL,
          // résidus markdown, troncatures). Le titre de la page est une source bien plus
          // sûre quand il est exploitable ; on ne retombe sur le segment qu'en dernier recours.
          const titleClean = title
            .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
            .replace(/\]\([^)]*\)/g, ' ')
            .replace(/\bREF\s*\d+[A-Z]?\s*#+/gi, ' ')
            .replace(/#{2,}/g, ' ')
            .replace(/^\s*(jpg|jpeg|png|gif|webp|html?)\)?\s*/i, ' ')
            .replace(/^["']/, '')
            .replace(/\s+/g, ' ')
            .trim();
          // Un titre utile a au moins un mot de 5+ lettres (évite "VERSAI" tronqué, "VERSA" etc.)
          const titleLooksUsable = titleClean && titleClean.length >= 12 && /[a-zàâäéèêëïîôùûüç]{5,}/i.test(titleClean);
          let adresseGuess;
          if (titleLooksUsable) {
            adresseGuess = titleClean;
          } else {
            const cutPoint = Math.min(160, segmentClean.length);
            adresseGuess = segmentClean.substring(0, cutPoint).trim();
            const slugMatch = adresseGuess.match(/^[a-z0-9-]{8,}(?:\s|$)/);
            if (slugMatch) adresseGuess = adresseGuess.slice(slugMatch[0].length) || adresseGuess;
            adresseGuess = adresseGuess.split('.').pop().trim();
            const looksLikeNoise = !adresseGuess || adresseGuess.length < 12 ||
              /^(jpg|jpeg|png|ref\s*\d|###|\*+|[a-z0-9-]{10,}$)/i.test(adresseGuess) ||
              !/[a-zàâäéèêëïîôùûüç]{5,}/i.test(adresseGuess);
            if (looksLikeNoise) adresseGuess = r._zone || zone1;
          }

          annonces.push({
            adresse: adresseGuess.substring(0, 80),
            ville: detectZoneFromText(title + ' ' + segmentClean, zones, r._zone || zone1),
            surface: surface > 0 ? Math.round(surface) : null,
            prix: prix,
            prix_m2: prix_m2 > 0 ? prix_m2 : null,
            type: type,
            source: source,
            description: segmentClean.substring(0, 250),
            lien: url
          });
        }
      }

      return res.status(200).json({
        content: [{ type: 'text', text: JSON.stringify({ annonces: annonces }) }]
      });

    } else {
      // Agents 02-04 : passthrough vers Groq (gratuit, llama-3.3-70b-versatile).
      // NB: avant, ce bloc appelait api.anthropic.com (payant) malgré la variable
      // nommée groqMsgs — résidu de bug, l'intention d'origine était bien Groq.
      const groqMsgs = msgs.map(function(m) {
        return { role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      });

      const gRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          max_tokens: body.max_tokens || 2000,
          messages: groqMsgs
        })
      });

      const gData = await gRes.json();
      const text = (gData.choices && gData.choices[0] && gData.choices[0].message)
        ? gData.choices[0].message.content
        : 'Erreur de génération';

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
