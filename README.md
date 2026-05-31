# Kids English Learning App - Backend

Backend сервер для детского образовательного приложения с многопользовательской поддержкой через WebSocket.

## Технологии

- **Node.js** + TypeScript
- **Express** - REST API
- **Socket.io** - Real-time WebSocket communication
- **PostgreSQL** - Основная база данных
- **Redis** - Кеширование и Socket.io adapter
- **Docker** - Контейнеризация

## Структура проекта

```
backend/
├── src/
│   ├── config/         # Конфигурация БД
│   ├── models/         # Модели данных (User, Session, Progress)
│   ├── routes/         # REST API маршруты
│   ├── websocket/      # WebSocket обработчики
│   ├── middleware/     # Middleware (rate limiting, errors)
│   ├── utils/          # Утилиты (logger, session codes)
│   ├── types/          # TypeScript типы
│   ├── scripts/        # Скрипты миграций
│   └── server.ts       # Главный файл сервера
├── logs/               # Логи
├── Dockerfile          # Docker образ
├── docker-compose.yml  # Docker compose конфигурация
└── deploy.sh           # Скрипт деплоя
```

## Установка и запуск (локально)

### 1. Установите зависимости

```bash
cd backend
npm install
```

### 2. Настройте переменные окружения

```bash
cp .env.example .env
# Отредактируйте .env файл
```

### 3. Запустите PostgreSQL и Redis

```bash
docker-compose up -d postgres redis
```

### 4. Выполните миграции

```bash
npm run migrate
```

### 5. Запустите сервер в режиме разработки

```bash
npm run dev
```

Сервер будет доступен на `http://localhost:3001`

## Запуск через Docker

### Полный стек (Backend + PostgreSQL + Redis)

```bash
docker-compose up -d
```

### Проверка статуса

```bash
docker-compose ps
docker-compose logs -f api
```

### Остановка

```bash
docker-compose down
```

## Деплой на Yandex Cloud

### Требования

- Виртуальная машина на Yandex Cloud с Ubuntu
- Docker и Docker Compose установлены на сервере
- SSH доступ к серверу

### Подготовка сервера

```bash
# Подключиться к серверу
ssh ubuntu@YOUR_SERVER_IP

# Установить Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Установить Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Перезайти для применения прав
exit
```

### Деплой

```bash
# Из локальной папки backend/
chmod +x deploy.sh
./deploy.sh YOUR_SERVER_IP ubuntu
```

Скрипт автоматически:
1. Соберет приложение
2. Создаст tar архив
3. Загрузит на сервер
4. Запустит Docker контейнеры
5. Выполнит миграции БД
6. Проверит health check

### Настройка .env на сервере

```bash
ssh ubuntu@YOUR_SERVER_IP
cd /home/ubuntu/kids-english-backend
nano .env

# Установите правильные значения:
# - DB_PASSWORD
# - SESSION_SECRET
# - CORS_ORIGIN (URL вашего frontend)
```

Перезапустите после изменения .env:

```bash
docker-compose restart
```

## API Endpoints

### REST API

#### Создать сессию урока (учитель)
```
POST /api/session/create
Body: {
  "teacherName": "Мария Ивановна",
  "islandId": 1,
  "mode": "synchronized"
}
Response: {
  "success": true,
  "data": {
    "session": {...},
    "sessionCode": "A3B5C7",
    "teacherId": "uuid"
  }
}
```

#### Получить информацию о сессии
```
GET /api/session/:sessionId
```

#### Получить прогресс ученика
```
GET /api/progress/student/:studentId/session/:sessionId
```

#### Health check
```
GET /health
```

### WebSocket Events

#### Клиент → Сервер

- `join:session` - Присоединиться к сессии (учитель или ученик)
- `teacher:changeActivity` - Учитель меняет активность
- `student:updateProgress` - Ученик обновляет прогресс

#### Сервер → Клиент

- `activity:changed` - Активность изменена
- `student:joined` - Ученик присоединился
- `student:left` - Ученик вышел
- `student:progress` - Обновление прогресса ученика

## Мониторинг и логи

### Логи контейнеров

```bash
# Все логи
docker-compose logs -f

# Только API
docker-compose logs -f api

# PostgreSQL
docker-compose logs -f postgres

# Redis
docker-compose logs -f redis
```

### Логи приложения

Логи сохраняются в `./logs/` директории:
- `error.log` - только ошибки
- `combined.log` - все логи

```bash
tail -f logs/combined.log
```

### Метрики

Health check endpoint: `GET /health`

```bash
curl http://localhost:3001/health
```

Ответ:
```json
{
  "status": "ok",
  "timestamp": "2024-02-08T20:00:00.000Z",
  "uptime": 12345.67
}
```

## Безопасность

### Rate Limiting

- Общий API: 100 запросов/минута
- Создание сессий: 5 запросов/15 минут
- Загрузка файлов: 10 запросов/минуту

### CORS

Настройте `CORS_ORIGIN` в `.env`:

```bash
CORS_ORIGIN=https://your-frontend-domain.com
```

### Защита

- Helmet.js для HTTP headers
- Non-root Docker пользователь
- Health checks для отказоустойчивости
- Graceful shutdown для корректного завершения

## Troubleshooting

### Порт уже занят

```bash
# Найти процесс на порту 3001
lsof -i :3001
# Остановить
kill -9 PID
```

### База данных недоступна

```bash
# Проверить статус PostgreSQL
docker-compose ps postgres
docker-compose logs postgres

# Перезапустить
docker-compose restart postgres
```

### Redis недоступен

```bash
# Проверить Redis
docker-compose exec redis redis-cli ping
# Должно вернуть PONG

# Очистить кеш
docker-compose exec redis redis-cli FLUSHALL
```

### Миграции не применились

```bash
# Применить вручную
docker-compose exec api npm run migrate

# Или через psql
docker-compose exec postgres psql -U app_user -d english_app
```

## Разработка

### Локальный запуск с hot-reload

```bash
npm run dev
```

### Сборка

```bash
npm run build
```

### Линтинг

```bash
npm run lint
```

## Backup

### Резервное копирование БД

```bash
# Создать backup
docker-compose exec postgres pg_dump -U app_user english_app > backup.sql

# Восстановить
cat backup.sql | docker-compose exec -T postgres psql -U app_user english_app
```

### Backup Redis

```bash
# Создать snapshot
docker-compose exec redis redis-cli BGSAVE

# Файл сохранится в volume redis_data
```

## Масштабирование

Для увеличения количества инстансов API:

```bash
docker-compose up -d --scale api=3
```

Redis adapter автоматически синхронизирует WebSocket между инстансами.

## License

Private - Kids English Learning App
