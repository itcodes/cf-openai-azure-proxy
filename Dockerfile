FROM node:20-slim

WORKDIR /app

RUN npm install -g wrangler@4

ENV WRANGLER_SEND_METRICS=false

COPY cf-openai-azure-proxy.js wrangler.toml docker-entrypoint.sh ./

RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8787

CMD ["/app/docker-entrypoint.sh"]
