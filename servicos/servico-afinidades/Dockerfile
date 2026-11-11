# Node 20 em cima do Alpine: imagem pequena, sobe rápido no compose
FROM node:20-alpine
WORKDIR /app

# Primeiro só os manifests. Se mexermos apenas no index.js, o Docker
# reaproveita a camada do npm install e o rebuild leva segundos.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .
EXPOSE 4003
CMD ["node", "index.js"]
