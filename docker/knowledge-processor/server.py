"""Internal-only parser transport. Each request gets a killable, resource-limited process."""
import hmac
import json
import multiprocessing
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from parser import ImportFailure, parse

LIMIT = 20 * 1024 * 1024  # Includes server-held page results when retrying OCR.
SLOTS = threading.BoundedSemaphore(1)


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
        token = os.environ.get('KNOWLEDGE_PROCESSOR_TOKEN', '')
        if len(token) < 32 or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
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
            if not receiver.poll(110):
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
    if len(os.environ.get('KNOWLEDGE_PROCESSOR_TOKEN', '')) < 32:
        raise SystemExit('KNOWLEDGE_PROCESSOR_TOKEN must be at least 32 characters')
    server = ThreadingHTTPServer(('0.0.0.0', 8091), Handler)
    server.daemon_threads = True
    server.serve_forever()
