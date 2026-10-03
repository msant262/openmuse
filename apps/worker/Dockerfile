FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app/apps/worker
COPY apps/worker/package.json apps/worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && ln -s /app/apps/worker/node_modules /app/node_modules && mkdir /data && chown pwuser:pwuser /data /app
COPY --chown=pwuser:pwuser apps/worker/src ./src
# Keep ../../../packages/domain imports at their actual runtime location.
COPY --chown=pwuser:pwuser packages/domain/src /app/packages/domain/src
COPY LICENSE /usr/share/licenses/openmuse/LICENSE
COPY package.json /app/package.json
USER pwuser
ENV NODE_ENV=production WORKER_DATA_DIR=/data WORKER_HOST=0.0.0.0
EXPOSE 8790
CMD ["node", "--experimental-strip-types", "src/index.ts"]
