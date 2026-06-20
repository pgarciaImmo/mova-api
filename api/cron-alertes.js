// Cron job déclenché automatiquement par Vercel (voir vercel.json à la racine du repo)
// 2 fois par jour. Réutilise EXACTEMENT la même logique de recherche que api/claude.js
// (via le module partagé api/lib/chasseur.js), pour ne jamais désynchroniser les deux.
// Envoie un mail récapitulatif de toutes les annonces trouvées vers pgarcia.immo@gmail.com,
// sans filtre ni tri (Paulo a explicitement demandé "tout ce qu'il a trouvé").

const nodemailer = require('nodemailer');
const { chercherAnnonces } = require('./lib/chasseur.js');

// Zones et surface par défaut : mêmes valeurs par défaut que claude.js, car le cron
// n'a pas d'utilisateur en train de taper une requête — il tourne seul, à heure fixe.
const ZONES_DEFAUT = 'Paris 16e, Paris 15e, Paris 11e, Versailles';
const SURFACE_MIN_DEFAUT = 17;

function formatAnnoncesHtml(annonces) {
  if (annonces.length === 0) {
    return '<p>Aucune annonce trouvée lors de ce run.</p>';
  }
  const rows = annonces.map(function(a) {
    const prix = a.prix ? a.prix.toLocaleString('fr-FR') + ' €' : 'Prix non détecté';
    const surface = a.surface ? a.surface + ' m²' : '';
    const prixM2 = a.prix_m2 ? a.prix_m2.toLocaleString('fr-FR') + ' €/m²' : '';
    return '<tr style="border-bottom:1px solid #ddd;">' +
      '<td style="padding:8px;font-weight:bold;">' + (a.type || 'Bien') + '</td>' +
      '<td style="padding:8px;">' + (a.ville || '') + '</td>' +
      '<td style="padding:8px;color:#1A5FA8;font-weight:bold;">' + prix + '</td>' +
      '<td style="padding:8px;">' + surface + (prixM2 ? ' (' + prixM2 + ')' : '') + '</td>' +
      '<td style="padding:8px;font-size:13px;">' + (a.adresse || '').substring(0, 100) + '</td>' +
      '<td style="padding:8px;"><a href="' + (a.lien || '#') + '" target="_blank">Voir l\'annonce</a></td>' +
      '<td style="padding:8px;font-size:12px;color:#888;">' + (a.source || '') + '</td>' +
      '</tr>';
  }).join('');

  return '<table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">' +
    '<thead><tr style="background:#1A5FA8;color:white;">' +
    '<th style="padding:8px;text-align:left;">Type</th>' +
    '<th style="padding:8px;text-align:left;">Ville</th>' +
    '<th style="padding:8px;text-align:left;">Prix</th>' +
    '<th style="padding:8px;text-align:left;">Surface</th>' +
    '<th style="padding:8px;text-align:left;">Adresse / Titre</th>' +
    '<th style="padding:8px;text-align:left;">Lien</th>' +
    '<th style="padding:8px;text-align:left;">Source</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

module.exports = async function handler(req, res) {
  try {
    const annonces = await chercherAnnonces(ZONES_DEFAUT, SURFACE_MIN_DEFAUT);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    const now = new Date();
    const dateStr = now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

    const htmlBody =
      '<div style="font-family:Arial,sans-serif;">' +
      '<h2 style="color:#1A5FA8;">MOVA - Chasseur d\'opportunités</h2>' +
      '<p>Run automatique du ' + dateStr + '</p>' +
      '<p><strong>' + annonces.length + ' annonce(s) trouvée(s)</strong> sur les zones : ' + ZONES_DEFAUT + '</p>' +
      formatAnnoncesHtml(annonces) +
      '<p style="margin-top:20px;font-size:12px;color:#888;">Mail automatique envoyé par MOVA (movaapi.vercel.app). Aucun tri ni filtre appliqué : toutes les annonces détectées par Agent 01 sont listées ci-dessus.</p>' +
      '</div>';

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: 'MOVA - ' + annonces.length + ' annonce(s) trouvée(s) - ' + now.toLocaleDateString('fr-FR'),
      html: htmlBody
    });

    return res.status(200).json({ success: true, annonces_count: annonces.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
