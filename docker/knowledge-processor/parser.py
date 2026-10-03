"""Untrusted document -> bounded, passive HTML. No network access, no logging text."""
import base64
import csv
import hashlib
import html
import io
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
import zipfile
from html.parser import HTMLParser
from pathlib import PurePosixPath
from urllib.parse import urlsplit

MAX_FILE = 10 * 1024 * 1024
MAX_TEXT = 800_000
MAX_PAGES = 40
MAX_ASSETS = 24
VERSION = 'livo-import-1'


class ImportFailure(Exception):
    pass


def safe_url(value):
    value = value.strip()
    if any(ord(c) < 32 for c in value):
        return None
    parsed = urlsplit(value)
    if parsed.scheme in ('https', 'http') and parsed.hostname and not parsed.username and not parsed.password:
        return value
    if value.startswith('#') and re.fullmatch(r'#[A-Za-z0-9_-]+', value):
        return value
    return None


class PassiveHTML(HTMLParser):
    tags = {'p', 'br', 'strong', 'em', 's', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a'}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.suppressed = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'iframe', 'object', 'svg', 'math'):
            self.suppressed += 1
        if self.suppressed or tag not in self.tags:
            return
        extra = ''
        if tag == 'a':
            href = safe_url(dict(attrs).get('href', ''))
            if href:
                extra = ' href="' + html.escape(href, quote=True) + '" target="_blank" rel="noopener noreferrer"'
        self.out.append('<' + tag + extra + '>')
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'iframe', 'object', 'svg', 'math'):
            self.suppressed = max(0, self.suppressed - 1)
            return
        if not self.suppressed and tag in self.tags and tag not in ('br', 'hr'):
            self.out.append('</' + tag + '>')
    def handle_data(self, data):
        if not self.suppressed:
            self.out.append(html.escape(data))


def sanitize(value):
    if len(value) > MAX_TEXT:
        raise ImportFailure('text_limit')
    parser = PassiveHTML()
    parser.feed(value)
    return ''.join(parser.out)


def markdown(raw):
    from markdown_it import MarkdownIt
    value = raw.decode('utf-8-sig', errors='strict')
    if len(value) > MAX_TEXT:
        raise ImportFailure('text_limit')
    parser = MarkdownIt('js-default').enable('table')
    # Images are not fetched. Untrusted URLs must never cause a browser request.
    parser.renderer.rules['image'] = lambda tokens, idx, *_: html.escape('[image: ' + tokens[idx].content + ']')
    body = sanitize(parser.render(value))
    warnings = ['historical_checkboxes'] if re.search(r'^\s*[-*+]\s+\[[ xX]\]', value, re.M) else []
    if re.search(r'!\[|<img|<iframe|<script|\]\((?!https?://|#)', value, re.I):
        warnings.append('embedded_or_relative_content_not_converted')
    return body, warnings


def checked_zip(raw):
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise ImportFailure('invalid_docx')
    infos = archive.infolist()
    if len(infos) > 1500:
        raise ImportFailure('zip_entry_limit')
    total = 0
    for entry in infos:
        path = PurePosixPath(entry.filename)
        if ('\\' in entry.filename or '\x00' in entry.filename or path.is_absolute()
                or '..' in path.parts or ':' in entry.filename or stat.S_ISLNK(entry.external_attr >> 16)):
            raise ImportFailure('zip_unsafe_path')
        if entry.flag_bits & 1:
            raise ImportFailure('zip_encrypted')
        total += entry.file_size
        if total > 40 * 1024 * 1024 or entry.file_size > 12 * 1024 * 1024 or entry.file_size > max(entry.compress_size, 1) * 200:
            raise ImportFailure('zip_expansion_limit')
        if entry.filename.lower().endswith(('vbaproject.bin', '.exe', '.dll')):
            raise ImportFailure('active_office_content')
    if 'word/document.xml' not in archive.namelist():
        raise ImportFailure('invalid_docx')
    # Prevent XML entity expansion before a third-party OOXML library sees it.
    for entry in infos:
        if entry.filename.endswith(('.xml', '.rels')):
            xml = archive.read(entry)
            if re.search(br'<!\s*(DOCTYPE|ENTITY)', xml, re.I):
                raise ImportFailure('xml_entities_forbidden')
    return archive


def docx(raw):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    archive = checked_zip(raw)
    warnings = ['word_layout_review']
    assets = []
    for info in archive.infolist():
        if info.filename.startswith('word/media/'):
            ext = info.filename.rsplit('.', 1)[-1].lower()
            if ext not in ('png', 'jpg', 'jpeg', 'gif', 'webp'):
                warnings.append('unsupported_image')
                continue
            if len(assets) >= MAX_ASSETS or info.file_size > 2 * 1024 * 1024:
                warnings.append('asset_limit')
                continue
            data = archive.read(info)
            assets.append({'name': PurePosixPath(info.filename).name, 'data': base64.b64encode(data).decode(),
                           'type': 'image/' + ('jpeg' if ext in ('jpg', 'jpeg') else ext)})
        if info.filename.endswith('.rels') and b'TargetMode="External"' in archive.read(info):
            warnings.append('external_relationships_not_fetched')
        if info.filename.startswith(('word/comments', 'word/embeddings')):
            warnings.append('comments_or_embedded_objects_not_converted')
    document = Document(io.BytesIO(raw))
    result = []
    def paragraph(p):
        content = []
        # Preserve hyperlinks as passive text; external relationships are never fetched.
        for part in p.iter_inner_content():
            if hasattr(part, 'runs'):
                text = html.escape(part.text)
                href = safe_url(getattr(part, 'url', ''))
                content.append('<a href="' + html.escape(href, quote=True) + '">' + text + '</a>' if href else text)
            else:
                text = html.escape(part.text).replace('\n', '<br>')
                if part.bold: text = '<strong>' + text + '</strong>'
                if part.italic: text = '<em>' + text + '</em>'
                content.append(text)
        style = p.style.name if p.style else ''
        heading = re.match(r'Heading ([1-6])$', style)
        tag = 'h' + heading.group(1) if heading else 'p'
        prefix = '• ' if style.startswith('List') else ''
        return '<' + tag + '>' + prefix + ''.join(content) + '</' + tag + '>'
    for block in document.iter_inner_content():
        if isinstance(block, Paragraph):
            result.append(paragraph(block))
        elif isinstance(block, Table):
            result.append('<table><tbody>' + ''.join('<tr>' + ''.join('<td>' + ''.join(paragraph(p) for p in cell.paragraphs) + '</td>' for cell in row.cells) + '</tr>' for row in block.rows) + '</tbody></table>')
    if b'<w:ins' in archive.read('word/document.xml') or b'<w:del' in archive.read('word/document.xml'):
        warnings.append('tracked_changes_review')
    return sanitize(''.join(result)), list(dict.fromkeys(warnings)), assets


def ocr_page(path, number, work):
    if os.environ.get('KNOWLEDGE_OCR_ENABLED') != '1' or not shutil.which('pdftoppm') or not shutil.which('tesseract'):
        return {'page': number, 'state': 'ocr_pending', 'text': '', 'confidence': None}
    prefix = os.path.join(work, 'page')
    try:
        subprocess.run(['pdftoppm', '-f', str(number), '-l', str(number), '-singlefile', '-scale-to', '2400', '-png', path, prefix],
                       check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        result = subprocess.run(['tesseract', prefix + '.png', 'stdout', '-l', 'eng+chi_tra+chi_sim', 'tsv'],
                                check=True, timeout=25, capture_output=True)
        rows = list(csv.DictReader(io.StringIO(result.stdout.decode('utf-8')), delimiter='\t'))
        words = [r for r in rows if r.get('text', '').strip() and float(r.get('conf', '-1')) >= 0]
        confidence = sum(float(r['conf']) for r in words) / len(words) if words else 0
        text = ' '.join(r['text'] for r in words)
        return {'page': number, 'state': 'needs_review' if text else 'ocr_failed', 'text': text,
                'confidence': round(confidence, 1), 'engine': 'tesseract', 'language': 'eng+chi_tra+chi_sim',
                'low_confidence': [{'text': r['text'], 'bbox': [int(r[k]) for k in ('left', 'top', 'width', 'height')]} for r in words if float(r['conf']) < 65][:100]}
    except (subprocess.SubprocessError, ValueError):
        return {'page': number, 'state': 'ocr_failed', 'text': '', 'confidence': None}
    finally:
        try: os.unlink(prefix + '.png')
        except FileNotFoundError: pass


def pdf(raw, previous=None):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(raw), strict=True)
    if reader.is_encrypted:
        raise ImportFailure('encrypted_pdf')
    if len(reader.pages) > MAX_PAGES:
        raise ImportFailure('page_limit')
    result, pages, warnings = [], [], ['pdf_layout_review']
    started = time.monotonic()
    cached = {p['page']: p for p in (previous or []) if isinstance(p, dict) and p.get('state') in ('text', 'needs_review') and isinstance(p.get('text'), str) and len(p['text']) <= MAX_TEXT}
    with tempfile.TemporaryDirectory() as work:
        path = os.path.join(work, 'input.pdf')
        with open(path, 'wb') as output: output.write(raw)
        for number, page in enumerate(reader.pages, 1):
            try:
                if number in cached:
                    item = cached[number]
                    pages.append(item)
                    result.append('<h2>Page ' + str(number) + '</h2><p>' + html.escape(item['text']).replace('\n', '<br>') + '</p>')
                    continue
                if time.monotonic() - started > 65:
                    pages.append({'page': number, 'state': 'ocr_pending', 'text': '', 'confidence': None})
                    result.append('<h2>Page ' + str(number) + '</h2>')
                    continue
                stream = page.get_contents()
                if stream and len(stream.get_data()) > 12 * 1024 * 1024:
                    raise ImportFailure('pdf_page_stream_limit')
                text = page.extract_text() or ''
                # Mixed pages can contain a header but a scanned body. Inspect every page.
                has_images = bool(page.images)
                if len(text.strip()) < 30 or (has_images and len(text.strip()) < 150):
                    item = ocr_page(path, number, work)
                    if item['state'] in ('ocr_pending', 'ocr_failed') and text.strip():
                        item['text'] = text
                else:
                    item = {'page': number, 'state': 'text', 'text': text, 'confidence': None}
            except ImportFailure:
                raise
            except Exception:
                item = {'page': number, 'state': 'failed', 'text': '', 'confidence': None}
            pages.append(item)
            result.append('<h2>Page ' + str(number) + '</h2><p>' + html.escape(item['text']).replace('\n', '<br>') + '</p>')
    if any(p['state'] != 'text' for p in pages): warnings.append('ocr_review_required')
    return sanitize(''.join(result)), warnings, pages


def parse(payload):
    source = payload.get('source')
    if source not in ('md', 'docx', 'pdf'):
        raise ImportFailure('unsupported_format')
    try: raw = base64.b64decode(payload.get('data', ''), validate=True)
    except ValueError: raise ImportFailure('invalid_base64')
    if not raw or len(raw) > MAX_FILE:
        raise ImportFailure('file_size_limit')
    pages, assets = [], []
    if source == 'md': body, warnings = markdown(raw)
    elif source == 'docx': body, warnings, assets = docx(raw)
    else:
        previous = payload.get('previous_pages') if payload.get('previous_hash') == hashlib.sha256(raw).hexdigest() else None
        if previous is not None and (not isinstance(previous, list) or len(previous) > MAX_PAGES):
            raise ImportFailure('invalid_previous_pages')
        body, warnings, pages = pdf(raw, previous)
    if not re.sub('<[^>]+>', '', body).strip() and not any(p['state'] in ('ocr_pending', 'ocr_failed', 'failed') for p in pages):
        raise ImportFailure('empty_document')
    return {'body': body, 'warnings': warnings, 'pages': pages, 'assets': assets, 'parser_version': VERSION,
            'hash': hashlib.sha256(raw).hexdigest(), 'needs_review': bool(warnings),
            'incomplete': any(p['state'] in ('ocr_pending', 'ocr_failed', 'failed') for p in pages)}
