FROM node:24-alpine
ENV NODE_ENV=production PORT=5080
WORKDIR /app
COPY --chown=node:node package.json server.mjs LICENSE ./
COPY --chown=node:node public ./public
USER node
EXPOSE 5080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
