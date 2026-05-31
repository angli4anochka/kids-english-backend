# Руководство по деплою на Yandex Cloud

## Содержание

1. [Подготовка сервера](#1-подготовка-сервера)
2. [Настройка окружения](#2-настройка-окружения)
3. [Деплой приложения](#3-деплой-приложения)
4. [Проверка работы](#4-проверка-работы)
5. [Настройка домена (опционально)](#5-настройка-домена)
6. [Мониторинг и обслуживание](#6-мониторинг-и-обслуживание)

---

## 1. Подготовка сервера

### 1.1 Создание виртуальной машины на Yandex Cloud

1. Зайдите в консоль Yandex Cloud
2. Создайте новую виртуальную машину:
   - **Операционная система**: Ubuntu 22.04 LTS
   - **Ресурсы**: минимум 2 vCPU, 4 GB RAM
   - **Диск**: 20 GB SSD
   - **Сеть**: Публичный IP адрес

3. Сохраните публичный IP адрес вашего сервера

### 1.2 Подключение к серверу

```bash
# Замените YOUR_SERVER_IP на ваш IP адрес
ssh ubuntu@YOUR_SERVER_IP
```

### 1.3 Обновление системы

```bash
sudo apt update
sudo apt upgrade -y
```

### 1.4 Установка Docker

```bash
# Установить Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Установить Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Выйти и зайти снова для применения прав
exit
ssh ubuntu@YOUR_SERVER_IP
```

### 1.5 Проверка установки

```bash
docker --version
docker-compose --version
```

Должны увидеть версии Docker и Docker Compose.

---

## 2. Настройка окружения

### 2.1 Настройка firewall

```bash
# Открыть порты
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP
sudo ufw allow 443/tcp     # HTTPS
sudo ufw allow 3001/tcp    # Backend API
sudo ufw enable
```

### 2.2 Создание директории приложения

```bash
mkdir -p /home/ubuntu/kids-english-backend
cd /home/ubuntu/kids-english-backend
```

---

## 3. Деплой приложения

### 3.1 Автоматический деплой (рекомендуется)

На **локальной машине**, в папке `backend/`:

```bash
# Убедитесь что скрипт исполняемый
chmod +x deploy.sh

# Запустите деплой (замените YOUR_SERVER_IP)
./deploy.sh YOUR_SERVER_IP ubuntu
```

Скрипт автоматически:
- Соберет приложение
- Создаст архив
- Загрузит на сервер
- Запустит Docker контейнеры
- Выполнит миграции БД
- Проверит работу

### 3.2 Ручной деплой

Если автоматический деплой не работает:

#### На локальной машине:

```bash
cd backend
npm run build
tar -czf deploy.tar.gz dist/ package.json package-lock.json Dockerfile docker-compose.yml .env.example
scp deploy.tar.gz ubuntu@YOUR_SERVER_IP:/tmp/
```

#### На сервере:

```bash
cd /home/ubuntu/kids-english-backend
tar -xzf /tmp/deploy.tar.gz
rm /tmp/deploy.tar.gz

# Установить зависимости
npm ci --only=production
```

### 3.3 Настройка .env файла

```bash
# Создать .env из примера
cp .env.example .env

# Отредактировать
nano .env
```

Обязательно настройте:

```bash
# Генерируйте случайные пароли!
DB_PASSWORD=your_strong_password_here
SESSION_SECRET=your_random_secret_key_here

# URL вашего frontend (когда будет задеплоен)
CORS_ORIGIN=http://YOUR_SERVER_IP:5173

# Yandex Cloud Storage (если планируете использовать)
YC_STORAGE_ENDPOINT=https://storage.yandexcloud.net
YC_STORAGE_BUCKET=kids-english-media
YC_ACCESS_KEY_ID=your_key
YC_SECRET_ACCESS_KEY=your_secret
```

Сохраните: `Ctrl+X`, затем `Y`, затем `Enter`

### 3.4 Запуск контейнеров

```bash
cd /home/ubuntu/kids-english-backend
docker-compose up -d
```

### 3.5 Выполнение миграций

```bash
docker-compose exec api npm run migrate
```

---

## 4. Проверка работы

### 4.1 Статус контейнеров

```bash
docker-compose ps
```

Все 3 контейнера (api, postgres, redis) должны быть в состоянии "Up".

### 4.2 Просмотр логов

```bash
# Все логи
docker-compose logs -f

# Только API
docker-compose logs -f api

# Последние 100 строк
docker-compose logs --tail=100 api
```

### 4.3 Health check

```bash
curl http://localhost:3001/health
```

Должен вернуть:
```json
{
  "status": "ok",
  "timestamp": "2024-02-08T...",
  "uptime": 123.45
}
```

### 4.4 Проверка с внешнего устройства

На **локальной машине**:

```bash
curl http://YOUR_SERVER_IP:3001/health
```

Если не работает, проверьте firewall на сервере.

---

## 5. Настройка домена (опционально)

### 5.1 Установка Nginx

```bash
sudo apt install nginx -y
```

### 5.2 Настройка Nginx как reverse proxy

```bash
sudo nano /etc/nginx/sites-available/kids-english
```

Вставьте:

```nginx
server {
    listen 80;
    server_name your-domain.com;  # Замените на ваш домен

    # Backend API
    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket
    location /socket.io {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Health check
    location /health {
        proxy_pass http://localhost:3001;
    }
}
```

Активируйте:

```bash
sudo ln -s /etc/nginx/sites-available/kids-english /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 5.3 SSL сертификат (HTTPS)

```bash
# Установить Certbot
sudo apt install certbot python3-certbot-nginx -y

# Получить сертификат
sudo certbot --nginx -d your-domain.com
```

Certbot автоматически настроит HTTPS и редиректы.

---

## 6. Мониторинг и обслуживание

### 6.1 Автозапуск при перезагрузке

Docker Compose уже настроен с `restart: unless-stopped`, контейнеры запустятся автоматически.

### 6.2 Обновление приложения

```bash
# На локальной машине
cd backend
./deploy.sh YOUR_SERVER_IP ubuntu
```

Или вручную на сервере:

```bash
cd /home/ubuntu/kids-english-backend
docker-compose down
docker-compose pull
docker-compose up -d --build
```

### 6.3 Backup базы данных

```bash
# Создать backup
docker-compose exec postgres pg_dump -U app_user english_app > backup_$(date +%Y%m%d).sql

# Восстановить
cat backup_20240208.sql | docker-compose exec -T postgres psql -U app_user english_app
```

### 6.4 Очистка старых данных

```bash
# Удалить неиспользуемые Docker образы
docker system prune -a

# Удалить старые логи (старше 7 дней)
find logs/ -name "*.log" -mtime +7 -delete
```

### 6.5 Мониторинг ресурсов

```bash
# Использование ресурсов контейнерами
docker stats

# Дисковое пространство
df -h

# Память
free -h
```

### 6.6 Просмотр активных сессий

```bash
# Подключиться к Redis
docker-compose exec redis redis-cli

# Посмотреть все ключи сессий
KEYS session:*

# Посмотреть конкретную сессию
GET session:your-session-id
```

### 6.7 Перезапуск сервисов

```bash
# Перезапустить все
docker-compose restart

# Перезапустить только API
docker-compose restart api

# Перезапустить PostgreSQL
docker-compose restart postgres
```

---

## Troubleshooting

### Проблема: Контейнер не запускается

```bash
# Посмотреть логи
docker-compose logs api

# Проверить конфигурацию
docker-compose config
```

### Проблема: Не могу подключиться к БД

```bash
# Проверить что PostgreSQL запущен
docker-compose ps postgres

# Проверить логи
docker-compose logs postgres

# Проверить подключение изнутри
docker-compose exec api node -e "const {pgPool} = require('./dist/config/database'); pgPool.query('SELECT NOW()', console.log)"
```

### Проблема: WebSocket не работает

```bash
# Проверить Redis
docker-compose exec redis redis-cli ping

# Должно вернуть PONG

# Проверить что порт открыт
sudo ufw status
```

### Проблема: Высокая нагрузка

```bash
# Увеличить количество инстансов API
docker-compose up -d --scale api=3

# Ограничить память контейнера (в docker-compose.yml)
services:
  api:
    deploy:
      resources:
        limits:
          memory: 512M
```

---

## Контакты и поддержка

При возникновении проблем:

1. Проверьте логи: `docker-compose logs -f`
2. Проверьте статус: `docker-compose ps`
3. Проверьте health check: `curl http://localhost:3001/health`
4. Посмотрите в README.md раздел Troubleshooting

---

## Чеклист финального деплоя

- [ ] Сервер создан и доступен по SSH
- [ ] Docker и Docker Compose установлены
- [ ] Firewall настроен (порты 22, 80, 443, 3001)
- [ ] Приложение загружено на сервер
- [ ] .env файл настроен с безопасными паролями
- [ ] Контейнеры запущены: `docker-compose ps`
- [ ] Миграции выполнены: `docker-compose exec api npm run migrate`
- [ ] Health check работает: `curl http://YOUR_SERVER_IP:3001/health`
- [ ] WebSocket соединение тестируется
- [ ] Backup настроен (cron задача)
- [ ] Мониторинг логов настроен
- [ ] Домен настроен (опционально)
- [ ] SSL сертификат установлен (опционально)

Готово! Backend запущен и готов к работе! 🚀
