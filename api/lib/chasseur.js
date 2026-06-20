// Module partagé : logique Agent 01 (chasseur d'opportunités).
// Extrait de api/claude.js pour être réutilisable à la fois par :
//  - api/claude.js (appelé par le site MOVA quand Paulo clique "Nouvelle recherche")
//  - api/cron-alertes.js (déclenché automatiquement 2x/jour par Vercel Cron, sans
//    que le site ait besoin d'être ouvert, pour l'envoi de mail automatique)
// IMPORTANT : si tu modifies la logique de recherche/parsing, modifie-la UNIQUEMENT ici.
// Les deux fichiers appelants n'ont plus leur propre copie de cette logique.

async function chercherAnnonces(zonesRaw, surfMin) {
  const TAVILY_KEY = process.env.TAVILY_API_KEY;

  // Mots-clés de décote SECONDAIRES : combinés au format "[type] à rénover [ville]" déjà
  // présent dans la requête (donc "rénover" n'est pas répété ici pour éviter la redondance).
  // Ces mots-clés élargissent vers d'autres signaux de décote forte (succession, squat...).
  const kwRenovation = 'OR succession OR liquidation OR squatté OR vétusté';

  const zones = zonesRaw.split(',').map(function(z) { return z.trim(); }).filter(Boolean);
  const zone1 = zones[0] || 'Paris 16e';

  // Pour chaque zone demandée, on lance 3 requêtes (appartement / maison / bien commercial).
  // CHAQUE requête combine type de bien ET signal de décote (kwRenovation).
  // Format de requête : "[type] à rénover [ville]" — calque une vraie recherche humaine.
  const bienTerms = [
    'appartement',
    'maison',
    'bureau OR local commercial OR commerce OR entrepôt OR immeuble'
  ];
  const queries = [];
  const queryZones = [];
  for (let zi = 0; zi < zones.length; zi++) {
    for (let bi = 0; bi < bienTerms.length; bi++) {
      queries.push(bienTerms[bi] + ' à rénover ' + zones[zi] + ' ' + kwRenovation);
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
  function detectZoneFromText(text, zonesList, fallback) {
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

  function findAllPrices(text) {
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
      const prev = dedup[dedup.length - 1];
      const isCloseByPosition = prev && (found[i].index - prev.index <= 5);
      const isSameValueNearby = prev && (found[i].value === prev.value) && (found[i].index - prev.index <= 200);
      if (!prev || (!isCloseByPosition && !isSameValueNearby)) {
        dedup.push(found[i]);
      }
    }
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

  for (let ri = 0; ri < allResults.length; ri++) {
    const r = allResults[ri];
    const url = r.url || '';
    const title = r.title || '';
    const titleLower = title.toLowerCase();
    const rawContent = r.raw_content || r.content || '';
    const urlLower = url.toLowerCase();

    // EXCLURE domaines non pertinents.
    const excludedDomains = ['cbre.fr', 'jll.fr', 'bnpparibas-realestate.com', 'valuo.fr', 'youtube.com', 'youtu.be', 'zilek.com', 'mitula.fr'];
    if (excludedDomains.some(function(d) { return urlLower.includes(d); })) continue;
    if (rawContent.includes('Navigation überspringen')) continue;
    if (titleLower.includes('formation') || titleLower.includes('comment devenir')) continue;
    if ((urlLower.includes('/location') || titleLower.startsWith('louer ') || titleLower.startsWith('location ')) && !urlLower.includes('vente') && !titleLower.includes('vente') && !titleLower.includes('achat')) continue;

    const isDirectAnnonce = r.isIndividual ||
      /\/\d{6,}/.test(url) ||
      /-\d{6,}\.htm/.test(url);

    if (isDirectAnnonce) {
      if (seenUrls[url]) continue;
      seenUrls[url] = true;

      const prix = extractPriceNear(title + ' ' + rawContent, 0, 500);
      const surface = extractSurfaceNear(title + ' ' + rawContent, 0, 500, surfMin);
      if (prix === 0 && surface === 0) continue;
      const prix_m2 = (prix > 0 && surface > 0) ? Math.round(prix / surface) : 0;

      let source = 'Web';
      if (urlLower.includes('seloger')) source = 'SeLoger';
      else if (urlLower.includes('leboncoin')) source = 'LeBonCoin';
      else if (urlLower.includes('pap.fr')) source = 'PAP';
      else if (urlLower.includes('bienici')) source = 'BienIci';
      else if (urlLower.includes('logic-immo')) source = 'LogicImmo';

      const combinedLower = (title + ' ' + rawContent).toLowerCase();
      let type = 'Appartement';
      if (/\bmaison\b/.test(combinedLower)) type = 'Maison';
      else if (/\b(loft|duplex)\b/.test(combinedLower) && !/\bappartement\b/.test(combinedLower)) type = 'Atypique';
      else if (/\bappartement\b/.test(combinedLower)) type = 'Appartement';
      else if (/\bbureau(x)?\b/.test(combinedLower)) type = 'Bureau';
      else if (/\b(local commercial|commerce)\b/.test(combinedLower)) type = 'Commerce';
      else if (/\b(entrepôt|entrepot)\b/.test(combinedLower)) type = 'Entrepôt';
      else if (/\bimmeuble\b/.test(combinedLower)) type = 'Immeuble';

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

    const prices = findAllPrices(rawContent);
    let source = 'Web';
    if (urlLower.includes('seloger')) source = 'SeLoger';
    else if (urlLower.includes('leboncoin')) source = 'LeBonCoin';
    else if (urlLower.includes('bienici')) source = 'BienIci';
    else if (urlLower.includes('logic-immo')) source = 'LogicImmo';

    if (prices.length === 0) {
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

    if (seenUrls[url]) continue;
    seenUrls[url] = true;
    const maxPerPage = 5;
    for (let pIdx = 0; pIdx < Math.min(prices.length, maxPerPage); pIdx++) {
      const priceHit = prices[pIdx];
      const prix = priceHit.value;

      const prevPriceEnd = pIdx > 0 ? (prices[pIdx - 1].index + prices[pIdx - 1].length) : 0;
      const beforeWindowStart = Math.max(0, priceHit.index - 600, prevPriceEnd);
      const beforeWindow = rawContent.substring(beforeWindowStart, priceHit.index);

      const surfaceMatch = beforeWindow.match(/(\d{1,4}(?:[,\.]\d{1,2})?)\s*m[²2]/);
      let surface = 0;
      if (surfaceMatch) {
        const val = parseFloat(surfaceMatch[1].replace(',', '.'));
        if (val >= surfMin && val <= 5000) surface = val;
      }
      if (surface === 0) {
        surface = extractSurfaceNear(rawContent, priceHit.index, 150, surfMin);
      }

      const prix_m2 = (prix > 0 && surface > 0) ? Math.round(prix / surface) : 0;

      const segStart = Math.max(0, priceHit.index - 150);
      const segEnd = Math.min(rawContent.length, priceHit.index + 250);
      const segment = rawContent.substring(segStart, segEnd);

      const typeWindow = beforeWindow;

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

      function lastMatchIndex(regex, str) {
        let lastIdx = -1, m;
        const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
        while ((m = re.exec(str)) !== null) lastIdx = m.index;
        return lastIdx;
      }
      let type = 'Appartement';
      const typeChecks = [
        ['Maison', /\bmaison\b/i],
        ['Atypique', /\b(loft|duplex)\b/i],
        ['Appartement', /\bappartement\b/i],
        ['Bureau', /\bbureau(x)?\b/i],
        ['Commerce', /\b(local commercial|commerce)\b/i],
        ['Entrepôt', /\b(entrepôt|entrepot)\b/i],
        ['Immeuble', /\bimmeuble\b/i]
      ];
      let bestIdx = -1;
      for (let tc = 0; tc < typeChecks.length; tc++) {
        const idx = lastMatchIndex(typeChecks[tc][1], typeWindow);
        if (idx > bestIdx) { bestIdx = idx; type = typeChecks[tc][0]; }
      }

      const titleClean = title
        .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\]\([^)]*\)/g, ' ')
        .replace(/\bREF\s*\d+[A-Z]?\s*#+/gi, ' ')
        .replace(/#{2,}/g, ' ')
        .replace(/^\s*(jpg|jpeg|png|gif|webp|html?)\)?\s*/i, ' ')
        .replace(/^["']/, '')
        .replace(/\s+/g, ' ')
        .trim();
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

      const beforeWindowLower = typeWindow.toLowerCase();
      const isLocationSegment = /\bloyer\b/i.test(beforeWindowLower) ||
        (/\blocation\b/i.test(beforeWindowLower) && !/\bvente\b/i.test(beforeWindowLower));
      if (isLocationSegment) continue;

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

  return annonces;
}

module.exports = { chercherAnnonces };
