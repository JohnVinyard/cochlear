# Firebase auth emulator (the auth emulator is pure node;  no JRE needed)
FROM node:24-bookworm-slim
RUN npm install -g firebase-tools@14 && npm cache clean --force
WORKDIR /firebase
COPY firebase.json .firebaserc ./
COPY start.sh ./
EXPOSE 9099 4000
CMD ["sh", "start.sh"]
