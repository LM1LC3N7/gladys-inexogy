// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a text of the cloud, the e-mail nor the password: only our own words,
// error codes, counts and the values we checked.
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  // Rounded first: 59.99 s is told "1 min", never "60 s".
  if (Math.round(ms / 1000) >= 60) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** Our words for an error code of src/inexogy/client.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  http: { en: 'HTTP error', fr: 'erreur HTTP' },
  not_found: { en: 'meter not found', fr: 'compteur introuvable' },
  server: { en: 'error of the cloud', fr: 'erreur du cloud' },
  rate_limited: { en: 'too many requests', fr: 'trop de requêtes' },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  redirect: { en: 'unexpected redirection', fr: 'redirection inattendue' },
  bad_answer: { en: 'unexpected answer', fr: 'réponse inattendue' },
  refused: { en: 'login refused', fr: 'connexion refusée' },
  unauthorized: { en: 'access refused', fr: 'accès refusé' },
  forbidden: { en: 'access refused', fr: 'accès refusé' },
};

export function reason(err) {
  const text = REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
  const status =
    (err?.code === 'http' || err?.code === 'server') && Number.isInteger(err.status)
      ? ` ${err.status}`
      : '';
  return { en: `${text.en}${status}`, fr: `${text.fr}${status}` };
}

const kwh = (value) => Math.round(value * 1000) / 1000;

const join = (lang, first, notes) => [first[lang], ...notes.map((n) => n[lang])].join(' ');
const withNotes = (first, notes) => ({
  en: join('en', first, notes),
  fr: join('fr', first, notes),
});

/** One index held back, in a list: its meter and its values. */
const heldLine = ({ label, direction, from, to }) =>
  direction === 'down'
    ? {
        en: `${label}: ${kwh(from)} -> ${kwh(to)} kWh (a drop: never accepted, the index goes on by itself when the register comes back)`,
        fr: `${label} : ${kwh(from)} -> ${kwh(to)} kWh (une baisse : jamais acceptée, l’index reprend seul quand le registre revient)`,
      }
    : {
        en: `${label}: ${kwh(from)} -> ${kwh(to)} kWh (+${kwh(to - from)} kWh counted at once)`,
        fr: `${label} : ${kwh(from)} -> ${kwh(to)} kWh (+${kwh(to - from)} kWh comptés d’un coup)`,
      };

const lines = (items) => ({
  en: items.map((i) => heldLine(i).en).join('; '),
  fr: items.map((i) => heldLine(i).fr).join(' ; '),
});

export const T = {
  incomplete: {
    en: 'Enter the e-mail and the password of your inexogy customer account (the ones of the inexogy web portal).',
    fr: 'Saisissez l’e-mail et le mot de passe de votre compte client inexogy (ceux du portail web inexogy).',
  },
  /** `status`: the HTTP status of the refusal, when there was one. */
  refused: (status) => {
    const http = Number.isInteger(status) ? ` (HTTP ${status})` : '';
    return {
      en: `inexogy refused the login${http} (e-mail or password wrong, or API access closed): nothing more is sent with these credentials. Check them on the inexogy web portal, then save the right ones; or click "Test the connection" for one more try (never sooner than the interval).`,
      fr: `inexogy a refusé la connexion${http} (e-mail ou mot de passe erroné, ou accès à l’API fermé) : plus rien n’est envoyé avec ces identifiants. Vérifiez-les sur le portail web inexogy, puis enregistrez les bons ; ou cliquez sur « Tester la connexion » pour un nouvel essai (jamais avant l’intervalle).`,
    };
  },
  /** `notes`: { en, fr } texts added after the failure (an index held back). */
  unreachable: (err, wait, notes = []) =>
    withNotes(
      {
        en: `inexogy could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
        fr: `inexogy n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  /** HTTP 429 or 5xx: a pause, kept across restarts. */
  paused: (err, wait, notes = []) =>
    withNotes(
      {
        en: `inexogy asks to wait (${reason(err).en}): reads paused, new try in ${delay(wait).en}.`,
        fr: `inexogy demande d’attendre (${reason(err).fr}) : lectures en pause, nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  waiting: (next) => ({
    en: `Waiting for the first read of inexogy (in ${delay(next).en}).`,
    fr: `En attente de la première lecture d’inexogy (dans ${delay(next).fr}).`,
  }),
  noMeter: {
    en: 'Connected to inexogy, but this account has no meter.',
    fr: 'Connecté à inexogy, mais ce compte n’a aucun compteur.',
  },
  /** `count`: meters read; `notes`: { en, fr } texts added after. */
  ok: (count, notes = []) =>
    withNotes(
      {
        en: `Connected to inexogy: ${count} meter(s).`,
        fr: `Connecté à inexogy : ${count} compteur(s).`,
      },
      notes,
    ),
  notes: {
    noDevice: {
      en: 'Create the devices from the "Discover" tab to receive their values.',
      fr: 'Créez les appareils depuis l’onglet « Découverte » pour recevoir leurs valeurs.',
    },
    failing: (count) => ({
      en: `${count} meter(s) not read this time (new try at the next read).`,
      fr: `${count} compteur(s) non lu(s) cette fois (nouvel essai à la prochaine lecture).`,
    }),
    denied: (count) => ({
      en: `Access refused to ${count} meter(s) by inexogy (HTTP 401 or 403): asked again later, spaced up to 1 h.`,
      fr: `Accès refusé à ${count} compteur(s) par inexogy (HTTP 401 ou 403) : nouvel essai plus tard, espacé jusqu’à 1 h.`,
    }),
    truncated: {
      en: 'Only the first 10 meters of the account are read.',
      fr: 'Seuls les 10 premiers compteurs du compte sont lus.',
    },
    skipped: (count) => ({
      en: `${count} meter(s) without a usable identifier: no device for them.`,
      fr: `${count} compteur(s) sans identifiant utilisable : pas d’appareil pour eux.`,
    }),
    unsupported: (count) => ({
      en: `${count} meter(s) of a kind this integration does not read (only electricity, gas and water), or without any value yet.`,
      fr: `${count} compteur(s) d’un type que l’intégration ne lit pas (seulement électricité, gaz et eau), ou encore sans valeur.`,
    }),
    stale: (count) => ({
      en: `${count} meter(s) whose last reading is more than 15 minutes old at inexogy: their power and voltages are not sent.`,
      fr: `${count} compteur(s) dont le dernier relevé date de plus de 15 minutes chez inexogy : leur puissance et leurs tensions ne sont pas envoyées.`,
    }),
    budget: {
      en: 'Many values: some are sent at the next read (at most 280 values a minute).',
      fr: 'Beaucoup de valeurs : certaines sont envoyées à la prochaine lecture (280 valeurs par minute au plus).',
    },
    held: (items) => ({
      en: `Consumption index held back, not sent to the energy monitoring: ${lines(items).en}.${items.some((i) => i.direction === 'up') ? ' For a jump: if this energy was really consumed, click "Accept the held index" twice in the configuration of the integration.' : ''} Saving the configuration accepts nothing.`,
      fr: `Index de consommation retenu, non envoyé au suivi énergétique : ${lines(items).fr}.${items.some((i) => i.direction === 'up') ? ' Pour un saut : si cette énergie a vraiment été consommée, cliquez deux fois sur « Accepter l’index retenu » dans la configuration de l’intégration.' : ''} Enregistrer la configuration n’accepte rien.`,
    }),
  },
  accept: {
    nothing: {
      en: 'No index is held back: nothing to accept.',
      fr: 'Aucun index n’est retenu : rien à accepter.',
    },
    drop: {
      en: 'The index held back is a drop: it is never accepted, the index goes on by itself when the register comes back. A meter really replaced or reset: delete its device and create it again from the Discover tab. Nothing to accept.',
      fr: 'L’index retenu est une baisse : elle n’est jamais acceptée, l’index reprend seul quand le registre revient. Un compteur vraiment remplacé ou remis à zéro : supprimez son appareil et recréez-le depuis l’onglet Découverte. Rien à accepter.',
    },
    /** First click: what a second click would take, nothing taken yet. `drops`: drops held, never taken. */
    list: (items, within, drops = 0) => ({
      en: `Held back: ${lines(items).en}. Nothing accepted yet: click "Accept the held index" again within ${delay(within).en} to accept exactly these values (counted at the next read). A value that changes meanwhile stays held: click twice between two reads.${drops > 0 ? ` ${drops} drop(s) also held: never accepted, they correct themselves.` : ''}`,
      fr: `Retenu : ${lines(items).fr}. Rien n’est encore accepté : cliquez à nouveau sur « Accepter l’index retenu » dans les ${delay(within).fr} pour accepter exactement ces valeurs (comptées à la prochaine lecture). Une valeur qui change d’ici là reste retenue : cliquez donc deux fois entre deux lectures.${drops > 0 ? ` ${drops} baisse(s) aussi retenue(s) : jamais acceptée(s), elle(s) se corrige(nt) seule(s).` : ''}`,
    }),
    /** Second click. */
    done: (taken, changed) => ({
      en: `${taken.length > 0 ? `Accepted: ${lines(taken).en}; sent at the next read (plus what the home uses meanwhile), a different value stays held.` : 'Nothing accepted.'}${changed > 0 ? ` ${changed} value(s) changed since the list: still held, click again to see them.` : ''}`,
      fr: `${taken.length > 0 ? `Accepté : ${lines(taken).fr} ; envoyé à la prochaine lecture (plus ce que le foyer consomme d’ici là), une autre valeur reste retenue.` : 'Rien n’est accepté.'}${changed > 0 ? ` ${changed} valeur(s) ont changé depuis la liste : toujours retenue(s), cliquez à nouveau pour les voir.` : ''}`,
    }),
  },
  test: {
    /** The outcome of a read, `ago` ms ago (0: just now), the next one in `next` ms. */
    reading: (count, ago, next) => ({
      en: `${Math.round(ago / 1000) > 0 ? `Last read ${delay(ago).en} ago` : 'Read now'}: ${count} meter(s).${next > 0 ? ` Next read in ${delay(next).en}.` : ''}`,
      fr: `${Math.round(ago / 1000) > 0 ? `Dernière lecture il y a ${delay(ago).fr}` : 'Lu à l’instant'} : ${count} compteur(s).${next > 0 ? ` Prochaine lecture dans ${delay(next).fr}.` : ''}`,
    }),
    failed: (err, ago, next) => ({
      en: `${Math.round(ago / 1000) > 0 ? `Last read ${delay(ago).en} ago` : 'Read now'}: inexogy could not be read (${reason(err).en}).${next > 0 ? ` Next read in ${delay(next).en}.` : ''}`,
      fr: `${Math.round(ago / 1000) > 0 ? `Dernière lecture il y a ${delay(ago).fr}` : 'Lu à l’instant'} : inexogy n’a pas pu être lu (${reason(err).fr}).${next > 0 ? ` Prochaine lecture dans ${delay(next).fr}.` : ''}`,
    }),
    notYet: (next) => ({
      en: `No read yet with this configuration: the first one comes in ${delay(next).en} (never sooner than the interval).`,
      fr: `Pas encore de lecture avec cette configuration : la première vient dans ${delay(next).fr} (jamais avant l’intervalle).`,
    }),
    refusedWait: (next) => ({
      en: `inexogy refused these credentials. One more try is possible in ${delay(next).en} (never sooner than the interval); or save other credentials.`,
      fr: `inexogy a refusé ces identifiants. Un nouvel essai est possible dans ${delay(next).fr} (jamais avant l’intervalle) ; ou enregistrez d’autres identifiants.`,
    }),
    slow: {
      en: 'inexogy is slow to answer: look at the integration status in a minute.',
      fr: 'inexogy tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
  },
};
