# Синхронизация бэкенда локалка ↔ сервер (Яндекс VM)

Бэкенд **kids-english-backend** (Node API, PM2-процесс `kids-english-api`, порт 3003).

```
сервер: /home/ubuntu/repos/kids-english-backend.git   ← origin (bare-репо)
   ▲                                                         ▲
   │ push/pull                                               │ push/pull
   ▼                                                         ▼
сервер: /home/ubuntu/kids-english-backend (живой API)   локалка: ~/kids-english-backend
```

- **origin** = `ubuntu@158.160.208.163:/home/ubuntu/repos/kids-english-backend.git`
- SSH-ключ прописан в `.git/config` (`core.sshCommand`).
- API доступно: **https://uniplay-kids.ru/kids-api/** (PM2 `kids-english-api`).
- **`.env` НЕ в git** (там секреты/доступы к БД) — он лежит только на сервере и локально.
- Запуск на сервере: `dist/server-simple.js` (собирается через `npm run build:simple`).

## Изменения НА СЕРВЕРЕ → к себе
```bash
# на сервере (SSH):
/home/ubuntu/kids-backend-sync.sh
# локально:
git pull
```

## Изменения ЛОКАЛЬНО → на сервер
```bash
git add -A && git commit -m "что сделал"
./deploy.sh        # push + на сервере pull + build:simple + pm2 restart kids-english-api
```
