# Unganisha server

## Firebase (mara moja)
1. Authentication > Sign-in method > washa **Anonymous**.
2. Firestore Database > Create database > Rules > bandika `firestore.rules` > Publish.
3. Storage > Get started > Rules > bandika `storage.rules` > Publish.
4. Authentication > Settings > Authorized domains > ongeza domain ya Railway (mfano xxx.up.railway.app).

## Railway
- Weka folder hili kwenye GitHub, kisha Railway > New Project > Deploy from GitHub repo.
- Au tumia CLI: `railway login && railway init && railway up`.
- Railway inatumia `npm start` na PORT yake kiotomatiki. Kisha Settings > Networking > Generate Domain.

## Ujumbe halisi na simu (WebRTC)
- Bandika `firestore.rules` mpya (zina codes, chats, calls). Hakuna index za ziada zinazohitajika.
- Tumia HTTPS (Railway inatoa) ili kamera na mic zifanye kazi.
- Kwa mitandao ya simu yenye vikwazo, ongeza TURN server kwenye `ICE` ndani ya `public/index.html`.

## Push notifications (FCM)
1. Firebase Console > Project settings > Cloud Messaging > Web Push certificates > **Generate key pair**. Nakili key na ubandike kwenye `VAPID` ndani ya `public/index.html`.
2. Project settings > Service accounts > **Generate new private key** (faili la JSON).
3. Railway > Variables > ongeza `FIREBASE_SERVICE_ACCOUNT` na ubandike yaliyomo YOTE ya JSON hilo. Usiliweke kwenye GitHub.
4. Bandika `firestore.rules` mpya, redeploy, kisha kwenye Akaunti bonyeza **Washa arifa**.
