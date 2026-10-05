#!/usr/bin/env python3
"""Static listeners; authenticated player destinations are resolved from SQLite per request."""
import ipaddress,json,re,sys
from pathlib import Path
FIRST=8444
LAST=8543
TEMPLATE=r'''
map $http_upgrade $ar_connection_upgrade { default upgrade; '' close; }
server {
 listen 80;
 server_name @@ENDPOINT@@;
 return 301 https://$host$request_uri;
}
server {
 listen 443 ssl;
 server_name @@ENDPOINT@@;
 ssl_certificate @@ETC@@/tls.crt;
 ssl_certificate_key @@ETC@@/tls.key;
 ssl_protocols TLSv1.2 TLSv1.3;
 client_max_body_size 4g;
 client_body_timeout 900s;
 location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $http_host;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header X-AR-Gui-Port "";
  proxy_http_version 1.1;
  proxy_request_buffering off;
  proxy_buffering off;
  proxy_read_timeout 900s;
  proxy_send_timeout 900s;
 }
}
server {
 listen 8443 ssl;
 server_name @@ENDPOINT@@;
 ssl_certificate @@ETC@@/tls.crt;
 ssl_certificate_key @@ETC@@/tls.key;
 ssl_protocols TLSv1.2 TLSv1.3;
 client_max_body_size 64m;
 location = /_ar_router_auth {
  internal;
  proxy_pass http://127.0.0.1:8787/ar/router-auth;
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";
  proxy_set_header Host $http_host;
  proxy_set_header Cookie $http_cookie;
 }
 location / {
  auth_request /_ar_router_auth;
  error_page 401 = @login;
  proxy_pass http://@@ROUTER@@:80;
  proxy_set_header Host @@ROUTER@@;
  proxy_set_header Origin http://@@ROUTER@@;
  proxy_set_header Referer http://@@ROUTER@@/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $ar_connection_upgrade;
  proxy_redirect http://@@ROUTER@@/ https://$http_host/;
  proxy_redirect https://@@ROUTER@@/ https://$http_host/;
  proxy_cookie_domain @@ROUTER@@ $host;
  proxy_read_timeout 60s;
  proxy_connect_timeout 5s;
 }
 location @login { return 302 https://$host/; }
}
server {
@@LISTENERS@@
 server_name @@ENDPOINT@@;
 ssl_certificate @@ETC@@/tls.crt;
 ssl_certificate_key @@ETC@@/tls.key;
 ssl_protocols TLSv1.2 TLSv1.3;
 client_max_body_size 4g;
 client_body_timeout 900s;
 location = /_ar_player_auth {
  internal;
  proxy_pass http://127.0.0.1:8787/ar/player-auth;
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";
  proxy_set_header Host $http_host;
  proxy_set_header Cookie $http_cookie;
  proxy_set_header X-AR-Gui-Port $server_port;
 }
 location / {
  auth_request /_ar_player_auth;
  auth_request_set $ar_player $upstream_http_x_ar_upstream;
  auth_request_set $ar_player_host $upstream_http_x_ar_upstream_host;
  auth_request_set $ar_player_cookie $upstream_http_x_ar_upstream_cookie;
  error_page 401 = @login;
  proxy_pass $ar_player;
  proxy_set_header Host $ar_player_host;
  proxy_set_header Origin $ar_player;
  proxy_set_header Referer $ar_player/;
  proxy_set_header Cookie $ar_player_cookie;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $ar_connection_upgrade;
  proxy_request_buffering off;
  proxy_buffering off;
  proxy_next_upstream off;
  proxy_redirect $ar_player/ https://$http_host/;
  proxy_cookie_domain ~.+ $host;
  proxy_read_timeout 900s;
  proxy_send_timeout 900s;
  proxy_connect_timeout 5s;
 }
 location @login { return 302 https://$host/; }
}
'''
def render(settings,etc='/etc/anthias-rooms'):
    endpoint=settings['endpoint']
    if not re.fullmatch(r'[A-Za-z0-9.-]{1,253}',endpoint):raise ValueError('Invalid endpoint')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+',etc):raise ValueError('Invalid configuration directory')
    router=str(ipaddress.ip_interface(settings['routerAddress']).ip)
    values={'ENDPOINT':endpoint,'ETC':etc,'ROUTER':router,'LISTENERS':'\n'.join(f' listen {n} ssl;' for n in range(FIRST,LAST+1))}
    result=TEMPLATE
    for key,value in values.items():result=result.replace('@@'+key+'@@',value)
    return result
if __name__=='__main__':
    print(render(json.loads(Path(sys.argv[1]).read_text())))
