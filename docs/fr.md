# inexogy (Discovergy)

Intégration non officielle, sans lien avec inexogy. Elle lit les compteurs
communicants d'un **compte client inexogy** (anciennement Discovergy,
Allemagne) par l'**API officielle d'inexogy** (`api.inexogy.com`), avec
l'e-mail et le mot de passe du portail web inexogy. Lecture seule : rien
n'est jamais commandé.

> **Jamais testé avec un vrai appareil** ni un vrai compte inexogy : elle a
> été construite à partir de la bibliothèque pydiscovergy (utilisée par Home
> Assistant) et de ses réponses de test. Vos retours sont les bienvenus.

## Ce que vous obtenez

Un appareil Gladys par compteur du compte :

| Compteur    | Fonctions                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Électricité | puissance (W, telle qu'inexogy la donne : négative pendant l'injection sur un compteur bidirectionnel), **index de consommation** (kWh, envoyé au suivi énergétique de Gladys), registres tarif 1 et 2, index d'injection, puissance et tension de chaque phase |
| Gaz         | index de gaz (m³), simple capteur                                                                                                                                                                                                                               |
| Eau         | index d'eau (m³), simple capteur                                                                                                                                                                                                                                |

Une fonction n'existe qu'une fois sa valeur donnée par inexogy (un compteur :
une fois au-dessus de 0). Les autres types de compteurs (chaleur…) sont
signalés dans l'état, pas lus.

- L'**index de consommation** est le registre total du compteur lui-même
  (`energy`) : le cœur de Gladys en déduit seul la consommation et son coût.
  Ce n'est jamais une somme des tarifs et il ne contient jamais l'injection.
- **Le gaz et l'eau restent hors du suivi énergétique** (Gladys les
  facturerait au tarif de l'électricité) : simples capteurs de volume.
- Les registres par tarif et l'injection sont de simples capteurs (kWh dans
  leur nom) : en index, ils seraient comptés deux fois, ou facturés.

## Installation

1. Dans Gladys, ouvrez l'intégration et saisissez l'**e-mail** et le **mot
   de passe** de votre compte client inexogy (ceux de
   <https://my.inexogy.com/>). Le mot de passe est gardé par Gladys dans sa
   base, jamais réaffiché, et envoyé seulement à inexogy (`api.inexogy.com`,
   en HTTPS) à chaque requête (HTTP Basic, l'authentification de l'API
   officielle).
2. Choisissez si besoin les **minutes entre deux lectures** (1 par défaut,
   60 au plus).
3. Enregistrez, puis ouvrez l'onglet **Découverte** et créez les appareils
   voulus.

## Fonctionnement

- **Rythme** : une lecture par intervalle (le dernier relevé de chaque
  compteur, et la liste des compteurs une fois par heure), jamais plus
  souvent : ni après un redémarrage du conteneur (l'heure de la dernière
  lecture est gardée dans `/data`), ni à une reconnexion, un enregistrement
  du formulaire, l'onglet Découverte ou le bouton de test.
- **Connexion refusée** (HTTP 401 ou 403 sur la liste des compteurs) :
  l'intégration s'arrête et le dit ; plus rien n'est envoyé avec ces
  identifiants, même après un redémarrage. Enregistrez les bons, ou cliquez
  sur « Tester la connexion » pour un nouvel essai (jamais avant
  l'intervalle).
- **inexogy demande d'attendre** (HTTP 429, ou 5xx sur la liste des
  compteurs ou sur tous les compteurs) : toutes les lectures se mettent en
  pause, de 1 minute à 6 heures (son `Retry-After` est suivi dans ces
  bornes), y compris après un redémarrage. Un 5xx sur un seul compteur
  laisse les autres continuer.
- **Relevé périmé** : quand le dernier relevé d'un compteur d'électricité
  date de plus de 15 minutes selon l'horloge d'inexogy, sa puissance et ses
  tensions ne sont pas envoyées (jamais une vieille valeur comme neuve) ; les
  compteurs, si.
- Au plus 280 valeurs par minute sont envoyées à Gladys (sa limite est 300).

## L'index de consommation est protégé

Gladys compte chaque hausse d'un index en entier. Un raté (un registre à 0,
une valeur fausse) deviendrait des milliers de kWh. Donc :

- 0 n'est jamais envoyé ;
- une valeur plus basse que la précédente (une baisse) est retenue, et
  jamais acceptée : l'index reprend seul quand le registre revient. Un
  compteur vraiment remplacé ou remis à zéro : supprimez son appareil et
  recréez-le ;
- une hausse plus rapide que 100 kW en moyenne depuis la dernière valeur (un
  saut) est retenue, jamais confirmée par le temps, la répétition ou un
  redémarrage (gardée dans `/data`) ; pendant ce temps, la dernière valeur
  acceptée est renvoyée et l'état le signale. Si cette énergie a vraiment été
  consommée, cliquez deux fois sur **« Accepter l'index retenu »** : le
  premier clic liste les sauts, le second (dans les 5 minutes) prend
  exactement ces valeurs. Enregistrer la configuration n'accepte jamais rien.

Après 24 heures sans relevé, jusqu'à 2 400 kWh peuvent passer d'un coup (la
marge grandit avec le temps écoulé depuis la dernière valeur).

## Vie privée

`/data/inexogy-state.json` garde l'heure de la dernière lecture, une pause,
l'empreinte (salée) des identifiants refusés seulement (effacée au premier
succès) et la référence de chaque index de consommation. Jamais le mot de
passe, l'e-mail, un numéro de série ni une adresse : l'adresse qu'inexogy
garde pour un compteur n'est jamais lue. Les journaux et l'état ne
contiennent que nos propres mots.

## Limites

- Seuls les 10 premiers compteurs d'un compte sont lus.
- Les échelles des valeurs sont celles de Home Assistant (puissance en mW,
  énergie en 1e-10 kWh, volume en 1e-3 m³) ; les compteurs d'eau n'ont
  jamais été vus.
- Pas d'import d'historique, pas de désagrégation, pas de statistiques.
- Ce n'est pas l'intégration P1 Monitor, YouLess ni Tibber.

## Crédits

Les appels à l'API et le sens des valeurs sont portés de
[pydiscovergy](https://github.com/jpbede/pydiscovergy) (MIT, Jan-Philipp
Benecke) ; voir `THIRD_PARTY_NOTICES.md`.
