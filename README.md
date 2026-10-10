# Torrent Watch

Un tableau de bord indépendant pour laisser un proche suivre les téléchargements du serveur, sans lui donner accès à qBittorrent. Interface française, adaptée au téléphone, thème sombre.

**Version 0.1.0** · Application indépendante, sans accès aux fichiers de médias.

La CI publie l’image `ghcr.io/hloiseau/torrent-watch:0.1.0` après validation des tests. Pour installer l’image publiée, utiliser [`truenas-ghcr.yaml`](truenas-ghcr.yaml). La section ci-dessous décrit aussi la construction locale.

## Fonctionnement

- Connexion avec un compte de consultation, distinct de qBittorrent.
- Titres, progression, taille, débit descendant/montant, temps restant, état, seeds et peers (connectés / connus).
- Filtres En cours / Tout / Terminés et recherche par titre.
- Rafraîchissement toutes les 5 secondes, suspendu quand l’onglet est masqué.
- Les requêtes simultanées partagent le même appel qBittorrent ; cache de 5 secondes, y compris en cas de panne.
- Filtre de catégories appliqué **sur le serveur**, avant transmission au navigateur.
- Aucune commande d’ajout, de pause, de suppression ou de configuration.
- Aucun accès aux fichiers de médias, à Plex, à Sonarr/Radarr, ni au socket Docker.

Le navigateur contacte Torrent Watch. Le serveur Torrent Watch contacte l’API de qBittorrent en réseau privé. Les identifiants qBittorrent et sa session restent côté serveur. L’application ne relaie jamais une URL ou une route API envoyée par un visiteur.

L’interface publique expose uniquement sa page de connexion ; les données nécessitent une session. Aucun CDN, police distante, analytics ou ressource externe.

## Installation TrueNAS SCALE 25.10 — image GHCR (recommandé)

Image publiée : **`ghcr.io/hloiseau/torrent-watch:0.1.0`** (Linux amd64). Le téléchargement sans identifiants GHCR a été vérifié. Pas de construction locale nécessaire.

1. Dans **Apps → Discover Apps → menu ⋮ → Install via YAML**, coller [`truenas-ghcr.yaml`](truenas-ghcr.yaml).
2. Remplacer l’IP LAN du NAS, le port et les identifiants de la WebUI qBittorrent, puis choisir un mot de passe de consultation unique d’au moins 16 caractères.
3. Adapter `PUBLIC_ORIGIN` au domaine HTTPS utilisé dans Caddy ; ajouter le bloc de [`Caddyfile.example`](Caddyfile.example).
4. Optionnel : configurer `QBIT_CATEGORIES` avec la liste exacte des catégories à partager.
5. Accéder à l’adresse HTTPS et se connecter avec le compte de consultation. Aucun volume de médias ni accès Docker n’est nécessaire.

Ne pas rediriger le port 5080 ou la WebUI qBittorrent sur la box : seul Caddy reçoit le trafic Internet. Les identifiants de qBittorrent restent côté serveur. Pour des mots de passe contenant `$`, écrire `$$` dans le YAML Compose.

**Validation du 10 octobre 2026 :** 10 tests serveur, parcours navigateur à 1440 px et 390 px, construction Docker et publication GHCR réussis dans [GitHub Actions](https://github.com/hloiseau/torrent-watch/actions/runs/38082394347). La connexion au véritable qBittorrent reste à vérifier lors de l’installation.

## Variante : construire l’image localement sur TrueNAS

### 1. Construire l’image locale

Décompresser l’archive dans un dataset dédié, par exemple `/mnt/tank/apps/torrent-watch`. Adapter `tank` à ton pool. Depuis le shell TrueNAS ou SSH, dans le dossier qui contient `Dockerfile` :

```bash
cd /mnt/tank/apps/torrent-watch
sudo docker build -t torrent-watch:0.1.0 .
```

Cette construction télécharge l’image officielle Node 24 Alpine. Le projet n’installe aucune dépendance npm. Il ne faut pas installer Node ni npm sur TrueNAS.

Si tu construis l’image sur un autre ordinateur, utilise la même architecture que le NAS (ton Ryzen : amd64), puis transfère-la avec `docker save` / `docker load`.

### 2. Ajouter l’application

Dans **Apps → Discover Apps → menu ⋮ → Install via YAML**, donner par exemple le nom `torrent-watch`, puis coller le contenu de `truenas.yaml`.

Remplacer ces valeurs **avant** l’installation :

| Valeur | À renseigner |
|---|---|
| `PUBLIC_ORIGIN` | L’adresse HTTPS publique exacte, sans chemin : par exemple `https://suivi.hugoloiseau.fr` |
| `VIEWER_USERNAME` | L’identifiant à donner au proche ; `ami` par défaut |
| `VIEWER_PASSWORD` | Un mot de passe unique et aléatoire d’au moins 16 caractères, distinct de qBittorrent |
| `QBIT_URL` | L’URL de la WebUI qBittorrent, joignable depuis ce nouveau conteneur |
| `QBIT_USERNAME`, `QBIT_PASSWORD` | Les identifiants de la WebUI qBittorrent |
| `192.168.1.10:5080:5080` | Remplacer l’IP par celle du NAS sur le LAN, pour que Caddy puisse atteindre le service |

`QBIT_URL` peut par exemple être `http://IP_DU_NAS:PORT_WEBUI`. **Ce n’est pas le port BitTorrent.** Si qBittorrent est derrière Gluetun, utiliser le port WebUI accessible du conteneur VPN ou celui publié sur le NAS. `localhost` dans Torrent Watch désigne Torrent Watch, pas le NAS ni qBittorrent.

Le YAML utilise `pull_policy: never` : l’image `torrent-watch:0.1.0` doit déjà exister localement. Elle n’est pas disponible sur Docker Hub/GHCR. Ne pas supprimer cette image lors d’un nettoyage des images inutilisées ; conserver les sources pour pouvoir la reconstruire.

### 3. Restreindre ce qui est visible

Par défaut, **tous les torrents sont visibles**, y compris ceux ajoutés manuellement. Pour partager uniquement les films et séries, activer cette variable :

```yaml
QBIT_CATEGORIES: '["radarr","sonarr"]'
```

Les noms doivent correspondre exactement aux catégories qBittorrent (majuscules comprises). Si tes catégories sont `movies` et `tv`, utiliser ces noms. Une catégorie absente de la liste n’est jamais envoyée au navigateur, même en modifiant ses requêtes. La catégorie vide peut être autorisée avec `""`. Un filtre vide ou mal formé est refusé au démarrage pour éviter d’ouvrir accidentellement l’accès à tout.

Ce n’est pas une intégration Seerr : tous les visiteurs autorisés voient la même sélection, pas uniquement leurs propres demandes.

### 4. Publier uniquement Torrent Watch avec Caddy

Ajouter le bloc de `Caddyfile.example` à ta configuration existante, en adaptant le domaine et l’IP :

```caddyfile
suivi.hugoloiseau.fr {
    reverse_proxy 192.168.1.10:5080
}
```

Configurer le DNS et l’accès HTTPS comme pour tes autres services. Seul Caddy doit être accessible depuis Internet. **Ne pas ouvrir les ports 5080 ni la WebUI qBittorrent sur la box.** La publication LAN du port 5080 sert à joindre Torrent Watch depuis Caddy ; elle n’est pas une redirection de port Internet.

Si Caddy et Torrent Watch partagent un réseau Docker, on peut supprimer `ports`, rattacher Torrent Watch à ce réseau externe et utiliser `reverse_proxy torrent-watch:5080`. Ne pas déclarer un nom de réseau inexistant : reprendre celui de ton installation.

Conserver les protections CSRF et Host de qBittorrent. Ne pas désactiver l’authentification pour l’adresse du conteneur Torrent Watch : le client attend un cookie de session après connexion. En cas d’erreur Host, configurer qBittorrent pour accepter le nom réellement utilisé dans `QBIT_URL`, sans désactiver la validation globalement.

### 5. Vérifier avant de partager

1. Ouvrir l’URL HTTPS en navigation privée : aucun torrent ne doit apparaître avant connexion.
2. Se connecter avec le compte de consultation et comparer les seeds/peers et la progression à qBittorrent.
3. Si un filtre de catégories est défini, vérifier qu’un torrent d’une autre catégorie est absent.
4. Tester la déconnexion et constater que le suivi redemande l’identifiant.
5. Donner uniquement l’URL publique et le compte de consultation au proche.

La sonde `/healthz` indique que le serveur HTTP fonctionne. Elle ne garantit pas la disponibilité de qBittorrent. L’interface signale une panne et date les dernières données conservées.

Référence TrueNAS : https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/

## Variante Docker Compose hors interface TrueNAS

```bash
cp .env.example .env
chmod 600 .env
# Renseigner les vraies valeurs dans .env.
docker compose up -d --build
```

Le port est lié à `127.0.0.1` par défaut. Pour un Caddy dans un conteneur séparé, adapter `BIND_IP` à l’IP LAN du NAS ou utiliser un réseau Docker commun. Ne pas utiliser en même temps Compose à la main et l’app TrueNAS pour gérer la même instance.

En YAML ou dans `.env`, attention aux `$` interprétés par Compose : utiliser `$$` dans le YAML, ou des valeurs entre apostrophes dans `.env`. Pour un nouveau mot de passe de consultation, un secret aléatoire hexadécimal évite ce problème. Ne jamais committer les vraies valeurs.

## Secrets montés en fichiers (facultatif)

Les deux mots de passe acceptent aussi `VIEWER_PASSWORD_FILE` et `QBIT_PASSWORD_FILE`. Monter les fichiers en lecture seule, les rendre lisibles par l’utilisateur `node` (UID 1000) et configurer leurs chemins internes. Ne pas définir simultanément une variable de mot de passe et sa variante `_FILE`. Cela évite de placer les mots de passe directement dans le YAML ; ils restent lisibles par l’application et l’administrateur du NAS.

Les mots de passe configurés en environnement restent visibles aux administrateurs du conteneur. Ils ne sont ni renvoyés dans l’API, ni enregistrés dans les logs.

## Développement et tests

Node.js 24 ou plus récent, aucune installation npm nécessaire :

```bash
npm test
# Pour un essai sur sa propre machine : copier et adapter .env.example.
# PUBLIC_ORIGIN=http://localhost:5080 et COOKIE_SECURE=false, puis :
node --env-file=.env server.mjs
```

Le mode HTTP est réservé aux tests sur un réseau de confiance : le mot de passe transite sans chiffrement. Le déploiement partagé utilise HTTPS, avec un cookie `__Host-`, Secure, HttpOnly et SameSite=Strict.

La suite automatise les scénarios suivants : refus d’accès anonyme, connexion/déconnexion, absence de commandes d’écriture, origine des requêtes, limitation des tentatives, projection des champs publics, filtre de catégories, cache partagé, reconnexion qBittorrent, erreurs sans fuite de secrets et refus des redirections amont. Elle utilise un faux serveur qBittorrent ; aucun torrent réel n’est modifié.

Test navigateur facultatif (sur une machine de développement, pas sur TrueNAS) :

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

Le script utilise uniquement des données fictives et un serveur local éphémère. Il vérifie la connexion, les filtres, la recherche, l’échappement des titres, la panne amont, la déconnexion et l’absence de débordement horizontal à 390 px. Il produit des captures ordinateur/mobile dans `test-results/`. Les tests navigateur et les 10 tests serveur ont été exécutés avec succès dans GitHub Actions. Les captures ordinateur et mobile ont également été inspectées.

## Limites assumées de cette première version

- Un compte de consultation partagé. Changer son mot de passe et redémarrer invalide toutes les sessions ; toutes les sessions sont perdues au redémarrage. Pas de base de données.
- Session de 12 h. Pas d’inscription, de récupération de mot de passe ou d’authentification Plex dans cette application séparée.
- Le backend utilise les identifiants qBittorrent habituels, qui peuvent avoir des droits d’écriture. Le caractère lecture seule est imposé par les routes de Torrent Watch, pas par un rôle qBittorrent. Le conteneur ne doit être accessible en administration qu’à toi.
- Connexion limitée à 10 tentatives / 15 min par adresse réseau, avec un plafond global de 20 / minute et 2 vérifications de mot de passe simultanées. Les en-têtes d’IP transférée sont ignorés. Derrière Caddy, les visiteurs partagent volontairement le quota de son adresse ; des échecs répétés peuvent donc bloquer temporairement toutes les nouvelles connexions, sans interrompre les sessions existantes.
- Connexion qBittorrent par identifiant/mot de passe et cookie SID ; pas de support d’une authentification intermédiaire supplémentaire ou d’un chemin API différent. API v2 compatible avec les champs des versions 4.1+ et 5.x, à confirmer sur ton instance réelle.
- Seeds/peers = nombre connecté / nombre connu dans l’essaim, pas promesse de sources joignables. `—` indique une donnée inconnue et le temps restant peut être indisponible. Aucun affichage d’IP ou de détail individuel des peers.
- Le téléchargement à 100 % ne garantit pas l’importation par Sonarr/Radarr ni l’indexation dans Plex.
- Pas d’historique persistant, de notifications, ni de contrôle du client. Liste limitée à 20 000 torrents / 8 Mio de réponse upstream pour borner l’usage mémoire.
- La construction Docker et le téléchargement anonyme de l’image ont été validés. Le déploiement sur le NAS et la connexion à son qBittorrent restent à vérifier sur ton installation.

## Publication GitHub / GHCR

Le projet est indépendant de LibraryDownloadarr et peut être poussé dans un nouveau dépôt public `hloiseau/torrent-watch`. Le workflow `Publish image` se déclenche sur les pushes de `main` (ou manuellement). Il exécute les tests serveur et navigateur, construit l’image Docker, puis publie les tags `0.1.0`, `latest` et `sha-<commit>` sur `ghcr.io/<propriétaire>/<dépôt>` avec le `GITHUB_TOKEN` du workflow. La CI de pull request vérifie les tests serveur et la construction sans publier.

La première publication d’un package GHCR peut être privée, même avec un dépôt public. Rendre le package public dans ses réglages avant de l’utiliser sans identifiants sur TrueNAS. Une fois le workflow réussi et la visibilité vérifiée, utiliser `truenas-ghcr.yaml`. Ce YAML cible l’image publique `ghcr.io/hloiseau/torrent-watch:0.1.0`, dont le téléchargement anonyme a été vérifié le 10 octobre 2026. L’ancienne variante `truenas.yaml` reste disponible pour une image construite localement.

Licence Apache 2.0 (voir [LICENSE](LICENSE)).
