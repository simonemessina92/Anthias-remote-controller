from pathlib import Path
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse,unquote
from email.parser import BytesParser
from email import policy
import json,time,mimetypes,base64,struct,zlib
def fixture_bytes(name):
    # Generated transport payloads only: no uploaded photos or media in the repo.
    if name.endswith('.mp4'):return b'\x00\x00\x00\x18ftypmp42'+b'ANTHIAS_TEST_TRANSPORT_ONLY'*128
    def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
    width,height=32,24
    rows=b''.join(b'\x00'+b''.join(bytes((x*7%256,y*11%256,100)) for x in range(width)) for y in range(height))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b'')
WRITES=[]
def asset(id, name, file, active=False):
    return {'asset_id': id, 'name': name, 'uri': '/data/anthias_assets/' + id + '-' + file, 'mimetype': 'video' if file.endswith('.mp4') else 'image', 'duration': 10, 'is_enabled': active, 'is_active': active, 'is_processing': False, 'is_reachable': True, 'start_date': '2000-01-01T00:00:00Z', 'end_date': '2099-12-31T23:59:59Z', 'play_order': 0, 'play_days': [1, 2, 3, 4, 5, 6, 7], 'play_time_from': None, 'play_time_to': None, 'metadata': {}, '_file': file}

def public(a):
    return {k: v for k, v in a.items() if not k.startswith('_')}

class Player:

    def __init__(self, n):
        self.assets = {f'h{n}': asset(f'h{n}', f'Home · Room {n}', 'portrait.png' if n == 1 else 'hotel2.png', True), f'e{n}': asset(f'e{n}', f'Event · Room {n}', 'event.png'), f'v{n}': asset(f'v{n}', 'Library video', 'event.mp4'), f'x{n}': asset(f'x{n}', 'Unused archive', 'event.png')}
        self.number = n
        self.settings = {'shuffle_playlist': False}
        self.counter = 0
        self.data = {}
        self.uploadDelay = 0
        self.readDelay = 0
        self.patchFailure = None
        self.failControl = False
        self.processing = 0
        self.infoDelay = 0
        self.failUpload = False
        self.offlineUntil = 0
        self.bootTime = time.time() - 3600

    def handler(self):
        player = self

        class H(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def send(self, status, data=None, typ='application/json'):
                raw = json.dumps(data).encode() if typ == 'application/json' and data is not None else data or b''
                self.send_response(status)
                self.send_header('Content-Type', typ)
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type, Accept')
                self.send_header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_OPTIONS(self):
                self.send(204)

            def pathval(self):
                return unquote(urlparse(self.path).path)

            def get_asset(self, id):
                a = player.assets.get(id)
                if a and a.get('_until') and (time.time() >= a['_until']):
                    a['is_processing'] = False
                return a

            def do_GET(self):
                path = self.pathval()
                if time.time() < player.offlineUntil:
                    return self.send(503, {'detail': 'Simulated reboot'})
                if path == '/api/v2/assets':
                    if player.readDelay:
                        time.sleep(player.readDelay)
                    return self.send(200, [public(self.get_asset(id)) for id in list(player.assets)])
                if path == '/api/v2/device_settings':
                    return self.send(200, player.settings)
                if path == '/api/v2/integrations':
                    return self.send(200, {'balena_device_id': 'mock-identity-' + str(player.number)})
                if path == '/api/v2/info':
                    if player.infoDelay:
                        time.sleep(player.infoDelay)
                    return self.send(200, {'device_model': 'Raspberry Pi 4 (simulated)', 'anthias_version': 'v2026.9.0', 'free_space': '24.2 GB', 'display_power': 'No CEC display detected', 'under_voltage': {'supported': True, 'active': False, 'seen_since_boot': False}, 'storage': {'status': 'ok'}, 'uptime': {'days': 0, 'hours': max(0, time.time() - player.bootTime) / 3600}})
                if path.startswith('/api/v2/assets/control/'):
                    WRITES.append((self.server.server_port, 'SHOW', path))
                    return self.send(503 if player.failControl else 200, 'Viewer unavailable' if player.failControl else 'OK')
                if path.startswith('/api/v2/assets/') and path.endswith('/content'):
                    a = self.get_asset(path.split('/')[4])
                    raw = player.data.get(a['_file'], fixture_bytes(a['_file']))
                    return self.send(200, {'type': 'file', 'content': base64.b64encode(raw).decode(), 'filename': a['_file'], 'mimetype': a['mimetype']})
                if path.startswith('/api/v2/assets/'):
                    a = self.get_asset(path.split('/')[-1])
                    return self.send(200, public(a)) if a else self.send(404, {'detail': 'Not found'})
                if path.startswith('/assets/') and path.endswith('/preview/'):
                    a = self.get_asset(path.split('/')[2])
                    if not a:
                        return self.send(404)
                    raw = player.data.get(a['_file'])
                    if raw is None:
                        raw = fixture_bytes(a['_file'])
                    return self.send(200, raw, mimetypes.guess_type(a['_file'])[0] or 'application/octet-stream')
                self.send(404, {'detail': 'Not found'})

            def readbody(self):
                return self.rfile.read(int(self.headers.get('Content-Length', 0)))

            def do_POST(self):
                path = self.pathval()
                raw = self.readbody()
                WRITES.append((self.server.server_port, 'POST', path))
                if path == '/api/v2/assets/order':
                    ids = json.loads(raw)['ids'].split(',')
                    for i, id in enumerate(ids):
                        if id in player.assets:
                            player.assets[id]['play_order'] = i
                    return self.send(204)
                if path == '/api/v2/file_asset':
                    if player.uploadDelay:
                        time.sleep(player.uploadDelay)
                    if player.failUpload:
                        return self.send(507, {'detail': 'Storage full'})
                    msg = BytesParser(policy=policy.default).parsebytes(b'Content-Type: ' + self.headers['Content-Type'].encode() + b'\r\nMIME-Version: 1.0\r\n\r\n' + raw)
                    part = next((x for x in msg.iter_parts() if x.get_param('name', header='content-disposition') == 'file_upload'))
                    file = part.get_filename()
                    player.counter += 1
                    name = f'upload{player.counter}' + Path(file).suffix
                    player.data[name] = part.get_payload(decode=True)
                    return self.send(200, {'uri': '/tmp/' + name, 'ext': Path(file).suffix})
                if path == '/api/v2/assets':
                    b = json.loads(raw)
                    player.counter += 1
                    id = 'new' + str(player.counter)
                    a = asset(id, b['name'], Path(b['uri']).name)
                    a.update(b)
                    a['asset_id'] = id
                    a['uri'] = '/data/anthias_assets/' + a['_file']
                    a['is_active'] = a['is_enabled']
                    a['duration'] = 2 if a['mimetype'] == 'video' else a['duration']
                    a['is_processing'] = player.processing > 0
                    if player.processing:
                        a['_until'] = time.time() + player.processing
                    player.assets[id] = a
                    return self.send(201, public(a))
                if path == '/api/v2/reboot':
                    player.bootTime = time.time() + 4
                    player.offlineUntil = player.bootTime
                    return self.send(200, {'message': 'reboot requested'})
                self.send(404)

            def do_PATCH(self):
                id = self.pathval().split('/')[-1]
                b = json.loads(self.readbody())
                WRITES.append((self.server.server_port, 'PATCH', id, b))
                if id == 'device_settings':
                    player.settings.update(b)
                    return self.send(200, player.settings)
                if player.patchFailure == id:
                    player.patchFailure = None
                    return self.send(503, {'detail': 'Test failure'})
                a = self.get_asset(id)
                if not a:
                    return self.send(404)
                a.update(b)
                a['is_active'] = a['is_enabled'] and (not a['is_processing'])
                self.send(200, public(a))

            def do_DELETE(self):
                id = self.pathval().split('/')[-1]
                WRITES.append((self.server.server_port, 'DELETE', id))
                player.assets.pop(id, None)
                self.send(204)
        return H