# docker-cli (not a daemon-less image builder) because this container
# talks to the HOST's Docker daemon over the socket docker-compose.yml
# mounts into it — DockerDeploymentEngine's `docker run` for this image
# passes -v /var/run/docker.sock:/var/run/docker.sock.
#
# Build once: docker build -t dreamer-build-engine:local ./build-engine
FROM node:22-alpine
RUN apk add --no-cache git bash docker-cli
WORKDIR /home/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN chmod +x main.sh
ENTRYPOINT ["/home/app/main.sh"]
