# frontend da Ludoteca: é só HTML, CSS e JS estáticos (sem build, sem Node),
# então um nginx enxuto basta pra servir os arquivos na porta 80 do container
FROM nginx:alpine

# copia o site inteiro pra pasta padrão que o nginx já serve
COPY public/ /usr/share/nginx/html/

EXPOSE 80
