# Build the UI.
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/web/package.json packages/web/
RUN npm install
COPY packages/ packages/
RUN npm run build -w @wolfbox/telemetry && npm run build -w @wolfbox/web

# Run the service.
FROM python:3.12-slim
# ffmpeg is what makes the app work on Linux desktops, where Chromium refuses
# to decode the camera's HEVC without a hardware decoder.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app.py .
COPY --from=web /app/packages/web/dist ./static

ENV WOLFBOX_CACHE=/cache
VOLUME ["/cache"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8080/api/health')"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
