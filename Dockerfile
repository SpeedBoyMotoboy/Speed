# Servidor Speed Despacho. Monte um volume persistente em /dados (é o banco).
FROM node:22-slim
ENV NODE_ENV=production TZ=America/Sao_Paulo DADOS_DIR=/dados PORT=3000
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./src
COPY server/public ./public
RUN mkdir -p /dados && chown -R node:node /dados /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
