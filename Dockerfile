FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY public ./public
ENV PORT=4242
EXPOSE 4242
CMD ["node", "server/server.js"]
