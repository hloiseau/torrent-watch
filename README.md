# Torrent Watch

Un tableau de bord en lecture seule pour suivre qBittorrent sans exposer sa WebUI. Interface française, adaptée au téléphone : progression, débits, seeds, peers, état et temps restant.

**Version 0.2.0 : connexion avec Plex.** Seuls les comptes ayant accès au serveur Plex configuré peuvent consulter les téléchargements. Le compte de consultation partagé de la version 0.1.0 est supprimé.

## Installation sur TrueNAS SCALE 25.10

Image : `ghcr.io/hloiseau/torrent-watch:0.2.0` (Linux amd64). Le workflow publie cette version et `latest` après réussite des tests serveur et navigateur.

1. Récupérer le `machineIdentifier` de ton serveur Plex depuis le réseau local :

   ```bash
   curl -fsS http://IP_DU_NAS:PORT_PLEX/identity
   ```

   Le port Plex est généralement `32400`. Copier la valeur de `machineIdentifier` dans la réponse XML/JSON. Cet endpoint ne demande pas de token. Il faut l’identifiant, pas le nom du serveur, ni un `X-Plex-Token`. Si l’accès HTTP local est désactivé, utiliser l’URL HTTPS locale appropriée.

2. Dans **Apps → Discover Apps → menu ⋮ → Install via YAML**, nommer l’application `torrent-watch` et coller [`truenas-ghcr.yaml`](truenas-ghcr.yaml).
3. Remplacer les valeurs ci-dessous et conserver les protections du conteneur.
4. Configurer Caddy avec [`Caddyfile.example`](Caddyfile.example), puis ouvrir l’adresse HTTPS publique.
5. Cliquer sur **Se connecter avec Plex**, autoriser Torrent Watch chez Plex et revenir au tableau de bord.

| Variable | Valeur |
|---|---|
| `PUBLIC_ORIGIN` | L’adresse HTTPS publique exacte, sans chemin, par exemple `https://suivi.hugoloiseau.fr` |
| `PLEX_SERVER_ID` | Le `machineIdentifier` obtenu ci-dessus ; obligatoire |
| `QBIT_URL` | L’URL privée de la WebUI qBittorrent, joignable depuis le conteneur |
| `QBIT_USERNAME`, `QBIT_PASSWORD` | Les identifiants de cette WebUI |
| `QBIT_CATEGORIES` | Facultatif : liste JSON exacte des catégories visibles, par exemple `'["radarr","sonarr"]'` |
| `192.168.1.10:5080:5080` | Remplacer l’IP par celle du NAS sur le LAN, joignable depuis Caddy |

`QBIT_URL` utilise le port **WebUI**, pas le port BitTorrent. Si qBittorrent est derrière Gluetun, utiliser le port WebUI publié par le conteneur VPN ou sur le NAS. `localhost` désigne le conteneur Torrent Watch, pas le NAS.

Exemple Caddy :

```caddyfile
suivi.hugoloiseau.fr {
    reverse_proxy 192.168.1.10:5080
}
```

Seul Caddy doit recevoir le trafic Internet. Ne pas rediriger le port 5080 ni la WebUI qBittorrent sur la box. Aucun volume de médias, accès au socket Docker, token propriétaire Plex ou base de données n’est nécessaire. Le conteneur doit pouvoir joindre `plex.tv` en HTTPS ; le navigateur du visiteur doit pouvoir joindre `app.plex.tv`.

Si Caddy et Torrent Watch partagent un réseau Docker, il est possible de supprimer `ports`, de déclarer ce réseau existant et d’utiliser `reverse_proxy torrent-watch:5080`.

### Mise à jour depuis 0.1.0

Dans la configuration de l’app, remplacer l’image par `ghcr.io/hloiseau/torrent-watch:0.2.0`, supprimer `VIEWER_USERNAME` et `VIEWER_PASSWORD`, ajouter `PLEX_SERVER_ID`, puis redéployer. Les autres réglages restent identiques. Les anciennes sessions sont invalidées au redémarrage ; le mot de passe partagé ne permet plus de se connecter.

## Qui peut consulter le suivi ?

- Le propriétaire du serveur Plex configuré et les comptes Plex auxquels ce serveur est partagé.
- Un compte ayant seulement accès à un autre serveur est refusé. La vérification compare l’identifiant exact, jamais le nom du serveur.
- Chaque visiteur utilise son propre compte Plex. Les profils gérés Plex Home sans connexion Plex personnelle et le changement de profil Home ne sont pas pris en charge.
- Tous les visiteurs autorisés voient **la même sélection qBittorrent**. Les restrictions de bibliothèques Plex ne sont pas traduites en catégories de torrents, et le suivi ne se limite pas aux demandes personnelles Seerr.

**Sans `QBIT_CATEGORIES`, tous les torrents sont visibles**, y compris les ajouts manuels. Pour ne partager que certains téléchargements, définir par exemple :

```yaml
QBIT_CATEGORIES: '["radarr","sonarr"]'
```

Les noms doivent correspondre exactement aux catégories qBittorrent. Un filtre vide ou mal formé bloque le démarrage. Le filtrage est effectué côté serveur avant toute transmission au navigateur.

## Connexion et contrôle d’accès Plex

Le serveur crée un PIN fort via l’API Plex officielle. Le navigateur est redirigé vers Plex pour s’authentifier : Torrent Watch ne reçoit jamais le mot de passe Plex. Au retour, le backend récupère le token de l’utilisateur et vérifie la liste de ses serveurs autorisés. Le PIN est lié au navigateur initiateur par un cookie HttpOnly, expire après cinq minutes maximum et est consommé une seule fois. Aucun PIN ou token choisi par le navigateur n’est accepté.

La session dure 12 heures maximum. À chaque appel protégé, une autorisation vieille de cinq minutes est revérifiée auprès de Plex. Retirer le partage ou révoquer l’app chez Plex coupe donc les nouveaux accès au suivi à la prochaine vérification, sous réserve du délai de propagation chez Plex. Les informations déjà consultées ne peuvent évidemment pas être retirées de la mémoire du visiteur.

Si Plex ne répond pas lors d’une vérification requise, le suivi est bloqué jusqu’à une vérification réussie. Si Plex refuse l’accès, la session locale est supprimée. Déconnexion et redémarrage effacent les sessions et tokens conservés en mémoire. La déconnexion locale ne révoque pas l’autorisation de l’app dans le compte Plex ; le visiteur peut la retirer dans les appareils autorisés Plex.

Le flux PIN traditionnel documenté par Plex est utilisé. Son token de compte n’est pas un token limité à la lecture de ce tableau de bord : il reste exclusivement côté serveur, en mémoire, sans être envoyé au navigateur, écrit sur disque ou journalisé. L’application utilise uniquement les endpoints Plex de connexion, d’identité et de liste des ressources. Elle ne contacte pas les URL des serveurs retournées par Plex et ne lit aucun média.

Cookies : session `__Host-`, Secure, HttpOnly et SameSite=Strict ; cookie temporaire de connexion SameSite=Lax pour permettre le retour depuis Plex. Toutes les actions nécessitent l’origine configurée. HTTPS est requis pour le déploiement partagé.

Référence : [authentification et identité dans la documentation Plex](https://developer.plex.tv/pms/).

## Lecture seule qBittorrent

Le navigateur contacte uniquement Torrent Watch pour les données. Le backend ne possède que deux appels qBittorrent : connexion et lecture de la liste des torrents. Aucune route d’ajout, pause, suppression, réglage ou proxy générique n’est exposée. Les identifiants, hashes, chemins, liens magnet, trackers et IP des peers ne sont pas transmis.

Les identifiants qBittorrent peuvent avoir des droits d’écriture : la lecture seule est imposée par les routes de Torrent Watch, pas par un rôle qBittorrent. Conserver le conteneur sous ton seul contrôle administratif.

Conserver les protections CSRF, Host et l’authentification qBittorrent. Ne pas activer le contournement de connexion pour Torrent Watch : le client attend un cookie SID. En cas d’erreur Host, autoriser le nom utilisé dans `QBIT_URL` sans désactiver globalement la validation.

Rafraîchissement toutes les cinq secondes, suspendu si l’onglet est masqué. Les requêtes simultanées partagent un cache qBittorrent de cinq secondes. Lors d’une panne qBittorrent, l’interface conserve les anciennes données et leur date ; un refus ou une panne de vérification Plex masque le tableau de bord.

Seeds et peers indiquent les nombres connectés / connus dans l’essaim, sans promesse de disponibilité. « — » indique une valeur inconnue. Un téléchargement à 100 % peut encore attendre l’importation Sonarr/Radarr ou l’indexation Plex.

## Secrets et limites

- `QBIT_PASSWORD_FILE` permet de lire le mot de passe dans un fichier monté en lecture seule, lisible par UID 1000. Ne pas définir simultanément `QBIT_PASSWORD` et sa variante `_FILE`.
- Dans un YAML Compose, écrire `$$` pour un `$` littéral dans un mot de passe ; dans `.env`, utiliser des apostrophes. Ne pas committer les vraies valeurs.
- Les administrateurs du conteneur peuvent lire ses variables d’environnement et sa mémoire.
- Création de connexion limitée à 10 / 15 minutes par adresse réseau et 20 / minute au total. Les adresses transférées sont ignorées ; derrière Caddy, les visiteurs partagent le quota de son adresse. Les sessions existantes restent utilisables.
- Une requête de vérification PIN toutes les deux secondes maximum par connexion ; vérifications Plex simultanées regroupées par session, erreurs temporisées dix secondes.
- Pas d’historique persistant, notifications, contrôle qBittorrent ou intégration des demandes Seerr.
- `/healthz` indique que le serveur HTTP fonctionne, pas que Plex ou qBittorrent sont disponibles.

## Développement et validation

Node.js 24, aucune dépendance npm de production :

```bash
npm test
cp .env.example .env
# Renseigner les valeurs ; HTTP local uniquement :
# PUBLIC_ORIGIN=http://localhost:5080 et COOKIE_SECURE=false
node --env-file=.env server.mjs
```

Les tests couvrent les refus anonymes, le serveur Plex exact, le PIN lié au navigateur, son expiration et sa consommation unique, les cookies, CSRF, limites de connexion, révocation du partage, pannes Plex, absence de fuite de tokens, déconnexion et les protections qBittorrent. Les services Plex et qBittorrent sont simulés ; la connexion à ton NAS reste à vérifier sur place.

Test navigateur de développement :

```bash
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
npm run test:browser
```

Ce test local simule le passage chez Plex, vérifie les vues 1440 px / 390 px, filtres, recherche, échappement des titres, panne qBittorrent et déconnexion. La CI produit des captures dans l’artefact `browser-screenshots`.

Avant de partager : vérifier un compte autorisé, un compte sans accès au serveur, les catégories visibles et la révocation d’un partage après cinq minutes. Ces tests réels complètent les simulations automatiques.

## Construction locale et publication

Pour construire sur le NAS, depuis un dataset contenant les sources :

```bash
sudo docker build -t torrent-watch:0.2.0 .
```

Utiliser alors [`truenas.yaml`](truenas.yaml), avec `pull_policy: never`. Cette variante attend l’image locale. Ne pas installer Node/npm sur TrueNAS.

Pour Docker Compose hors interface TrueNAS : adapter `.env.example`, le copier en `.env`, puis `docker compose up -d --build`. Le port est lié à `127.0.0.1` par défaut ; adapter `BIND_IP` si Caddy est dans un autre conteneur. Ne pas faire gérer la même instance par Compose et l’app TrueNAS simultanément.

Le workflow [Publish image](https://github.com/hloiseau/torrent-watch/actions/workflows/publish.yml) teste, construit et publie les tags `0.2.0`, `latest` et `sha-<commit>` sur chaque push de `main`. Le package GHCR est public. Le tag `0.1.0` conserve l’ancienne version à mot de passe partagé.

Référence [interface Apps TrueNAS 25.10](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/).

Licence Apache 2.0 (voir [LICENSE](LICENSE)).
