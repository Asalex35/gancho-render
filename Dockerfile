# Gancho en contenedor: el mismo programa en la Mac mini, DigitalOcean, Render u otra nube.
# ffmpeg y los modelos de caras vienen incluidos (ffmpeg-static y modelos/).
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
# Datos locales (si no se usa S3/Spaces/R2): montar un volumen en /var/data y poner DATA_DIR=/var/data
RUN mkdir -p /var/data && chown -R node:node /var/data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# ROLE=all (web + trabajos) por defecto; para escalar: un servicio con ROLE=web y varios con ROLE=worker (requiere S3).
CMD ["node", "server.js"]
