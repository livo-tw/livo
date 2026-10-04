"""Internal-only parser transport. Each request gets a killable, resource-limited process."""
import hmac
import json
import multiprocessing
import os
import select
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from parser import ImportFailure, parse

LIMIT = 20 * 1024 * 1024  # Includes server-held page results when retrying OCR.
# Wall-clock budget for one parse. It must stay below the caller's wait (95 s in
# knowledgeImport.ts), which stays below the self-host function limit (150 s in
# functions/main): parser.py starts OCR pages only during its first 40 s and a
# page takes at most 40 s, so a normal parse ends before this budget.
BUDGET = 85
SLOTS = threading.BoundedSemaphore(1)


def configured_token():
    token = os.environ.get('KNOWLEDGE_PROCESSOR_TOKEN', '')
    return token if len(token) >= 32 else ''


def client_gone(connection):
    """True once the caller has closed the connection (timeout or cancelled import)."""
    try:
        readable, _, _ = select.select([connection], [], [], 0)
        return bool(readable) and connection.recv(1, socket.MSG_PEEK) == b''
    except (OSError, ValueError):
        return True


def work(payload, pipe):
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (640 * 1024 * 1024, 640 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (90, 95))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
    except ImportError:
        pass  # Windows tests; production is the Linux container with cgroup limits.
    try:
        pipe.send({'result': parse(payload)})
    except ImportFailure as error:
        pipe.send({'error': str(error)})
    except Exception:
        pipe.send({'error': 'invalid_document'})
    finally:
        pipe.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def reply(self, code, body):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)
    def do_POST(self):
        token = configured_token()
        if not token:
            return self.reply(503, {'error': 'processor_not_configured'})
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
            return self.reply(401, {'error': 'unauthorized'})
        if self.path != '/parse':
            return self.reply(404, {'error': 'not_found'})
        try: size = int(self.headers.get('Content-Length', '0'))
        except ValueError: size = 0
        if size < 1 or size > LIMIT:
            return self.reply(413, {'error': 'file_size_limit'})
        if not SLOTS.acquire(blocking=False):
            return self.reply(429, {'error': 'processor_busy'})
        process = None
        try:
            self.connection.settimeout(20)
            payload = json.loads(self.rfile.read(size))
            receiver, sender = multiprocessing.Pipe(duplex=False)
            process = multiprocessing.Process(target=work, args=(payload, sender))
            process.start()
            sender.close()
            deadline = time.monotonic() + BUDGET
            while not receiver.poll(0.5):
                # Nobody waits for an abandoned request: free the only slot now.
                if client_gone(self.connection):
                    self.close_connection = True
                    return None
                if time.monotonic() >= deadline:
                    return self.reply(422, {'error': 'processing_timeout'})
            result = receiver.recv()
            return self.reply(200 if 'result' in result else 422, result)
        except (ValueError, EOFError, OSError):
            return self.reply(422, {'error': 'invalid_document'})
        finally:
            if process:
                if process.is_alive(): process.kill()
                process.join(timeout=2)
            SLOTS.release()


if __name__ == '__main__':
    # Exiting here would only make Docker restart the container in a loop.
    # Stay up and refuse every request until the operator sets the token.
    if not configured_token():
        print('KNOWLEDGE_PROCESSOR_TOKEN must be at least 32 characters; refusing all requests.', file=sys.stderr)
    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('KNOWLEDGE_PROCESSOR_PORT', '8091'))), Handler)
    server.daemon_threads = True
    server.serve_forever()
