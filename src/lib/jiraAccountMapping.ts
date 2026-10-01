// The admin's "name, email" list for the Jira import — pasted text or an
// uploaded two-column CSV. One person per line; the last field containing
// "@" is the email and everything before it is the name. Comma, tab
// (pasted from a spreadsheet) and semicolon separators all work, and so does
// "Name <email>". A first line without an email is a header and is skipped.
// The server validates the emails; this only splits the text.

export interface AccountLine {
  name: string;
  email: string;
  /** 1-based line number in the pasted text. */
  line: number;
}

export interface AccountListParse {
  accounts: AccountLine[];
  /** Lines that are neither a header nor a "name, email" pair. */
  skipped: { line: number; text: string }[];
}

function splitFields(line: string): { fields: string[]; joiner: string } {
  const sep = line.includes('\t') ? '\t' : line.includes(',') ? ',' : line.includes(';') ? ';' : null;
  if (!sep) return { fields: line.trim().split(/\s+/), joiner: ' ' };
  const fields: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (ch === sep) {
      fields.push(cur);
      cur = '';
    } else cur += ch;
  }
  fields.push(cur);
  return { fields: fields.map((f) => f.trim()), joiner: ', ' };
}

export function parseAccountList(text: string): AccountListParse {
  const accounts: AccountLine[] = [];
  const skipped: { line: number; text: string }[] = [];
  const lines = (text || '').replace(/^\uFEFF/, '').normalize('NFKC').split(/\r\n|\r|\n/);
  let seenContent = false;
  lines.forEach((raw, i) => {
    const lineText = raw.trim();
    if (!lineText) return;
    const first = !seenContent;
    seenContent = true;
    const split = splitFields(lineText);
    const fields = split.fields.filter((f) => f !== '');
    let at = -1;
    for (let j = fields.length - 1; j >= 0; j--) {
      if (fields[j].includes('@')) {
        at = j;
        break;
      }
    }
    if (at < 0) {
      if (!first) skipped.push({ line: i + 1, text: lineText });
      return;
    }
    const email = fields[at].replace(/^[<("']+|[>)"']+$/g, '').trim();
    const name = fields.slice(0, at).join(split.joiner).trim();
    if (!name) {
      skipped.push({ line: i + 1, text: lineText });
      return;
    }
    accounts.push({ name, email, line: i + 1 });
  });
  return { accounts, skipped };
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A fill-in list: header + one "name," line per person. */
export function accountListTemplate(header: [string, string], names: string[]): string {
  return '\uFEFF' + [header.map(csvCell).join(','), ...names.map((n) => `${csvCell(n)},`)].join('\n') + '\n';
}
