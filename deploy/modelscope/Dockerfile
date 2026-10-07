FROM node:22-bookworm-slim AS frontend-build
WORKDIR /build/frontend
COPY source-part-*.txt /tmp/source-parts/
RUN cat /tmp/source-parts/source-part-*.txt | base64 -d | tar -xz -C /build \
    && test -s /build/frontend/package-lock.json && rm -r /tmp/source-parts
RUN npm ci --no-audit --no-fund
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production \
    BACKEND_URL=http://127.0.0.1:8020 \
    NEXT_PUBLIC_AUTH_MODE=invite \
    NEXT_PUBLIC_AUTH_HEADER=X-Companion-Authorization \
    NEXT_PUBLIC_OFFLINE_PREVIEW=false \
    NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW=false \
    NEXT_PUBLIC_LIFE_RUNTIME_ENABLED=true
COPY create-companion.tsx /build/frontend/components/create-companion.tsx
COPY api.ts /build/frontend/lib/api.ts
COPY personality.ts /build/frontend/lib/personality.ts
RUN npm run build

FROM python:3.12-slim-bookworm AS codec-build
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates && rm -r /var/lib/apt/lists/*
RUN git clone --depth 1 --branch 2.3.3 https://github.com/zlib-ng/zlib-ng.git /codec \
    && test "$(git -C /codec rev-parse HEAD)" = 12731092979c6d07f42da27da673a9f6c7b13586 \
    && cmake -S /codec -B /codec-build -DZLIB_COMPAT=ON -DZLIB_ENABLE_TESTS=OFF -DWITH_GTEST=OFF -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/codec \
    && cmake --build /codec-build --parallel 2 && cmake --install /codec-build

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends nginx ffmpeg libstdc++6 ca-certificates && rm -r /var/lib/apt/lists/*
COPY --from=frontend-build /usr/local/bin/node /usr/local/bin/node
COPY --from=codec-build /opt/codec /opt/codec
WORKDIR /app/backend
COPY --from=frontend-build /build/backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=frontend-build /build/backend/app ./app
COPY --from=frontend-build /build/backend/assets ./assets
COPY --from=frontend-build /build/backend/scripts ./scripts
COPY --from=frontend-build /build/frontend/.next/standalone /app/frontend
COPY --from=frontend-build /build/frontend/.next/static /app/frontend/.next/static
COPY --from=frontend-build /build/frontend/public /app/frontend/public
COPY --from=frontend-build /build/deploy/modelscope/nginx.conf /etc/nginx/nginx.conf
COPY start.py /app/start.py
COPY bootstrap_invites.py /app/backend/scripts/bootstrap_invites.py
COPY serve.py /app/backend/scripts/cloud_serve.py
COPY prompts.py /app/backend/app/services/prompts.py
COPY parsers.py /app/backend/app/services/parsers.py
COPY generation_errors.py /app/backend/app/services/generation_errors.py
COPY real_web_budget.py /app/backend/scripts/real_web_budget.py
COPY model_availability.py characters.py photos.py chat.py life_runtime.py personality.py /app/backend/app/api/
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=sqlite:////mnt/workspace/wanwu-companion/data/app.db \
    UPLOAD_DIR=/mnt/workspace/wanwu-companion/data/uploads \
    LD_LIBRARY_PATH=/opt/codec/lib APP_ENV=production AUTH_MODE=invite \
    GENERATION_QUOTA_ENABLED=true MODEL_MAX_RETRIES=0 SMS_LIVE_ENABLED=false \
    LIFE_RUNTIME_ENABLED=true LIFE_SIMULATION_ENABLED=false \
    LIFE_RUNTIME_PREVIEW_ENABLED=false LIFE_LIVE_PLANNER_PREVIEW_ENABLED=false
EXPOSE 7860
CMD ["python", "/app/start.py"]
