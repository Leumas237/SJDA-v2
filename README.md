# SJDA 💘 — L'app de rencontre de ton école

Une PWA (application web installable sur téléphone) pour aider les élèves à
sortir de leur bulle : se faire des amis, ou peut-être plus, si affinités !

## Fonctionnalités

- 🔥 **Découverte façon swipe** : glisse à droite pour liker, à gauche pour passer
- 🎉 **Match** quand deux personnes se likent mutuellement
- 🔓 **Réseaux débloqués par le match** : chacun renseigne son Instagram, Snapchat
  et WhatsApp dans son profil ; ils restent secrets et ne sont révélés qu'à tes
  matchs, avec des liens directs. Pas de messagerie interne à surveiller —
  la conversation continue là où les élèves discutent déjà
- 🤝 **Mode amitié / couple** : chacun choisit ce qu'il cherche, l'app ne propose
  que des profils compatibles
- ✋ **Inscriptions validées à la main** : chaque demande d'inscription doit être
  acceptée par un admin avant que l'élève accède à l'app
- 🏫 **Réservé à l'école** : inscription protégée par un code d'invitation
  et/ou le domaine email de l'école
- 📱 **PWA** : installable sur l'écran d'accueil, fonctionne sur tous les téléphones
- 🛡️ **Modération en temps réel** : tableau de bord admin avec statistiques,
  fil d'activité en direct, demandes d'inscription, signalements et bannissement

## Lancer en local

```bash
pip install -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Puis ouvre http://localhost:8000 — sur téléphone, utilise l'IP de ton PC
(ex. `http://192.168.1.10:8000`) en étant sur le même Wi-Fi.

> ⚠️ L'installation PWA et le WebSocket sécurisé nécessitent du HTTPS en
> production (Render, Railway, Fly.io… le fournissent automatiquement).

## Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `SJDA_INVITE_CODE` | `SJDA2026` | Code d'invitation à partager aux élèves |
| `SJDA_EMAIL_DOMAIN` | *(vide)* | Ex. `monecole.fr` : les emails de ce domaine s'inscrivent sans code |
| `SJDA_ADMIN_EMAILS` | *(vide)* | Emails des modérateurs, séparés par des virgules |
| `SJDA_APP_NAME` | `SJDA` | Nom affiché de l'app |
| `SJDA_DATA_DIR` | `./data` | Dossier de la base SQLite et des photos |

À l'inscription, **l'une ou l'autre** condition suffit : bon code d'invitation,
ou email du domaine de l'école.

## Architecture

```
backend/          API FastAPI + SQLite (aucune config serveur nécessaire)
  main.py         Routes : auth, profils, découverte, swipe, matchs, chat, WebSocket
  auth.py         Mots de passe PBKDF2 + sessions par jeton
  db.py           Schéma SQLite
  config.py       Configuration
frontend/         PWA en HTML/CSS/JS vanilla (aucun build nécessaire)
  index.html      Toutes les vues (auth, swipe, matchs, chat, profil)
  app.js          Logique SPA + swipe tactile + WebSocket
  sw.js           Service worker (cache hors-ligne de la coquille)
  manifest.json   Manifeste PWA
```

## Modération

Déclare les comptes modérateurs avec `SJDA_ADMIN_EMAILS` (l'onglet 🛡️
Modération apparaît pour eux). Le tableau de bord montre :

- les **demandes d'inscription** : tout nouveau compte est en attente jusqu'à
  ce qu'un admin l'accepte (l'élève peut préparer son profil en attendant,
  sa page se débloque automatiquement). Refuser supprime le compte
- les **statistiques** (élèves, demandes, matchs, signalements, bannis)
- un **fil d'activité en direct** (demandes, inscriptions, matchs,
  signalements — poussé par WebSocket, sans recharger la page)
- les **signalements** : chaque élève peut signaler un match via le bouton ⚠️
  de la fiche ; le match est supprimé immédiatement et les deux ne se
  recroisent plus. L'admin voit le motif, puis bannit ou classe sans suite
- la **liste des élèves** avec bannissement/rétablissement en un clic
  (le bannissement coupe les sessions et bloque la connexion)

Respect de la vie privée : il n'y a **pas de messagerie interne**, donc rien
à surveiller — et les réseaux sociaux d'un profil ne sont jamais visibles
avant un match mutuel.

## Sécurité & vie privée

- Mots de passe hachés (PBKDF2, 200 000 itérations), jamais stockés en clair
- Les réseaux sociaux (Insta/Snap/WhatsApp) ne sont exposés qu'aux matchs
- Les photos sont limitées à 5 Mo (JPEG/PNG/WebP)
- Pense à rappeler les règles de respect dans ta communication : l'app est
  faite pour créer du lien, pas pour harceler 💛

## Idées pour la suite

- Notifications push (l'infrastructure service worker est déjà en place)
- Suppression de compte et des données
- Filtres par classe ou par centres d'intérêt
- Vérification email par lien de confirmation
