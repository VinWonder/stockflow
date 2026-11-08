# Build context is the stockflow/ folder (see docker-compose.yml and render.yaml), so both web/ and backend/ are visible.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 FRONTEND_DIR=/web/dist
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
COPY --from=web /web/dist /web/dist
RUN SECRET_KEY=build python manage.py collectstatic --noinput
# On start: bring the database tables up to date, create the first admin if missing, then serve.
# PORT is set by cloud hosts such as Render; locally it falls back to 8000.
CMD ["sh", "-c", "python manage.py migrate --noinput && python manage.py ensure_admin && exec gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000} --workers ${WEB_CONCURRENCY:-3} --timeout 60"]
