import base64
import importlib.util
import io
import json
import os
import sys
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from parser import ImportFailure, checked_zip, markdown, parse, sanitize


def docx_fixture():
    from docx import Document
    doc = Document()
    doc.add_heading('Project Alpha', 1)
    doc.add_paragraph('A reviewed decision with <script>literal text</script>.')
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = 'Item'
    table.cell(0, 1).text = 'Decision'
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def pdf_fixture(scanned=False, mixed=False):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, NumberObject, DecodedStreamObject
    writer = PdfWriter()
    page = writer.add_blank_page(600, 180)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 20 Tf 15 130 Td (Project Alpha has a confirmed text decision ready for review.) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    if scanned or mixed:
        if scanned: writer.remove_page(0)
        glyphs = {'A':['01110','10001','10001','11111','10001','10001','10001'], 'L':['10000']*6+['11111'], 'P':['11110','10001','10001','11110','10000','10000','10000'], 'H':['10001']*3+['11111']+['10001']*3}
        text = 'ALPHA ALPHA ALPHA'
        scale = 10
        width, height = len(text)*6*scale+40, 130
        pixels = bytearray([255])*(width*height*3)
        for at, char in enumerate(text):
            for y, row in enumerate(glyphs.get(char, ['00000']*7)):
                for x, ink in enumerate(row):
                    if ink == '1':
                        for dy in range(scale):
                            for dx in range(scale):
                                pos = ((20+y*scale+dy)*width+20+at*6*scale+x*scale+dx)*3
                                pixels[pos:pos+3] = b'\x00\x00\x00'
        image = DecodedStreamObject()
        image.set_data(bytes(pixels))
        image.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Image'),NameObject('/Width'):NumberObject(width),NameObject('/Height'):NumberObject(height),NameObject('/ColorSpace'):NameObject('/DeviceRGB'),NameObject('/BitsPerComponent'):NumberObject(8)})
        page = writer.add_blank_page(width,height)
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Scan'):writer._add_object(image.flate_encode())})})
        stream = DecodedStreamObject()
        stream.set_data(f'q {width} 0 0 {height} 0 0 cm /Scan Do Q'.encode())
        page[NameObject('/Contents')] = writer._add_object(stream)
    out=io.BytesIO()
    writer.write(out)
    return out.getvalue()


def payload(source, data):
    return {'source':source,'data':base64.b64encode(data).decode()}


class ParserTests(unittest.TestCase):
    def test_markdown_is_passive(self):
        body,warnings=markdown(b'# Decision\n<script>alert(1)</script>\n![private](https://example.com/pixel)\n- [x] old\n[bad](javascript:evil)')
        self.assertNotIn('<script>',body)
        self.assertNotIn('<img',body)
        self.assertIn('historical_checkboxes',warnings)
        self.assertNotIn('href="javascript:',body)
    def test_sanitizer_removes_active_attributes(self):
        clean=sanitize('<p onclick="x">Okay<script>secret</script><a href="javascript:x">bad</a></p>')
        self.assertEqual(clean,'<p>Okay<a>bad</a></p>')
    def test_docx_order_and_table(self):
        result=parse(payload('docx',docx_fixture()))
        self.assertIn('<h1>Project Alpha</h1>',result['body'])
        self.assertIn('<table>',result['body'])
        self.assertIn('&lt;script&gt;',result['body'])
    def test_zip_traversal_and_expansion(self):
        for name,data in [('../evil',b'bad'),('word/document.xml',b'a'*1_000_000)]:
            out=io.BytesIO()
            with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:z.writestr(name,data)
            with self.assertRaises(ImportFailure):checked_zip(out.getvalue())
    def test_xml_entities_and_macros_rejected(self):
        for name,data in [('word/document.xml',b'<!DOCTYPE x>'),('word/vbaProject.bin',b'bad')]:
            out=io.BytesIO()
            with zipfile.ZipFile(out,'w') as z:
                z.writestr(name,data)
                if name!='word/document.xml':z.writestr('word/document.xml',b'<x/>')
            with self.assertRaises(ImportFailure):checked_zip(out.getvalue())
    def test_pdf_text_and_scan_pending(self):
        with patch.dict(os.environ,{'KNOWLEDGE_OCR_ENABLED':'0'}):
            result=parse(payload('pdf',pdf_fixture(mixed=True)))
        self.assertEqual([p['state'] for p in result['pages']],['text','ocr_pending'])
        self.assertTrue(result['incomplete'])
    def test_pdf_encrypted_rejected(self):
        from pypdf import PdfWriter
        writer=PdfWriter();writer.add_blank_page(200,200);writer.encrypt('test-only');out=io.BytesIO();writer.write(out)
        with self.assertRaisesRegex(ImportFailure,'encrypted_pdf'):parse(payload('pdf',out.getvalue()))
    def test_invalid_and_empty_rejected(self):
        for value in [{'source':'docm','data':'YQ=='},{'source':'md','data':'%%%'}]:
            with self.assertRaises(ImportFailure):parse(value)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.url=os.environ.get('PROCESSOR_TEST_URL')
        if not cls.url:raise unittest.SkipTest('HTTP integration requires the private processor container')
    def send(self,source,data,token=None):
        request=urllib.request.Request(self.url+'/parse',json.dumps(payload(source,data)).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+(token or os.environ['PROCESSOR_TEST_TOKEN'])})
        with urllib.request.urlopen(request,timeout=120) as response:return json.load(response)['result']
    def test_unauthorized_is_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as raised:self.send('md',b'# Test','incorrect')
        self.assertEqual(raised.exception.code,401)
    def test_all_formats_and_real_private_ocr(self):
        for source,data in [('md',b'# Text\n- [ ] Original'),('docx',docx_fixture()),('pdf',pdf_fixture())]:
            self.assertTrue(self.send(source,data)['body'])
        result=self.send('pdf',pdf_fixture(mixed=True))
        self.assertEqual([p['state'] for p in result['pages']],['text','needs_review'])
        self.assertIn('ALPHA',result['pages'][1]['text'].upper())
        self.assertTrue(result['needs_review'])
        self.assertFalse(result['incomplete'])


if __name__=='__main__':unittest.main()
