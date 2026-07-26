FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html app.js *.css /usr/share/nginx/html/
RUN chmod 644 /usr/share/nginx/html/*
