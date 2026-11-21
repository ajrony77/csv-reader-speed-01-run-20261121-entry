// A fast drop-in for make.fun's csv-reader 1.0.0.
//
// It returns exactly csv-reader's answer for every input {text, header}:
// {columns, rows, errors}. The reference reads one character at a time and
// builds every field up a character at a time, calling a function per
// field; this reader instead slices whole fields out of the text: a fast
// path splits quote-free lines on commas, and a field-by-field path scans
// the rest with short charCodeAt loops and slices, which is what makes it
// faster. The reading policy is csv-reader's own, kept exactly:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is
//     no record;
//   - outside a quoted field a CR not followed by LF is dropped
//     (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote and each CRLF or lone CR inside it
//     read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the
//     text after it is read again as an unquoted field
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows
//     holds the records after it (every record when header is false), each
//     padded with "" (short_row, with fields: its field count) or cut
//     (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on (every LF, CRLF and lone CR inside a quoted field
//     counted), row its record's index in rows (null for the header), in
//     the order met, a field's quote_junk when the field ends and a
//     record's short_row or long_row when the record ends.
//
// Two paths read a record. The fast path takes a record whose line holds
// no quote at a field start: no field in it opened with a quote, so no
// field can run past the line break, and the line splits on commas as it
// stands (a trailing CR of a CRLF ending stripped first). The slow path
// reads a record field by field with short charCodeAt scans, and handles
// quoted fields that run over line breaks, junk after a closing quote,
// stray CRs and a quote that never closes. A line that held only stray
// CRs is no record, but its stray_cr errors stay.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call
// to the next.

/** How a field ended: at the end of the text, at a line break, at a comma. */
const END = 0;
const BREAK = 1;
const COMMA = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Reads an unquoted field from pos, scanning it character by character:
  // the fields here are short, and one scan beats three indexOf calls.
  // `parts` holds pieces already read for this field (null while it is a
  // single slice). Returns the field and how it ended; `added` counts
  // the characters kept. `rLine`/`rRow` are the current record's line and
  // row, for stray_cr errors.
  function readUnquoted(parts, rLine, rRow) {
    let partStart = pos;
    let added = 0;
    for (;;) {
      let i = pos;
      let m = len;
      let kind = -1; // 0 comma, 1 LF, 2 CR
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 44) {
          m = i;
          kind = 0;
          break;
        }
        if (c === 10) {
          m = i;
          kind = 1;
          break;
        }
        if (c === 13) {
          m = i;
          kind = 2;
          break;
        }
        i++;
      }
      if (kind === -1) {
        // No delimiter left: the rest of the text is the field.
        if (parts === null) {
          pos = len;
          return { value: text.slice(partStart), ended: END, added: len - partStart };
        }
        parts.push(text.slice(partStart));
        added += len - partStart;
        pos = len;
        return { value: parts.join(''), ended: END, added };
      }
      if (kind === 0) {
        if (parts === null) {
          pos = m + 1;
          return { value: text.slice(partStart, m), ended: COMMA, added: m - partStart };
        }
        parts.push(text.slice(partStart, m));
        added += m - partStart;
        pos = m + 1;
        return { value: parts.join(''), ended: COMMA, added };
      }
      if (kind === 1) {
        if (parts === null) {
          pos = m + 1;
          line += 1;
          return { value: text.slice(partStart, m), ended: BREAK, added: m - partStart };
        }
        parts.push(text.slice(partStart, m));
        added += m - partStart;
        pos = m + 1;
        line += 1;
        return { value: parts.join(''), ended: BREAK, added };
      }
      // A CR at m: a CRLF ends the field at a line break, a lone CR is
      // dropped (stray_cr) and the field goes on past it.
      if (m + 1 < len && text.charCodeAt(m + 1) === 10) {
        if (parts === null) {
          pos = m + 2;
          line += 1;
          return { value: text.slice(partStart, m), ended: BREAK, added: m - partStart };
        }
        parts.push(text.slice(partStart, m));
        added += m - partStart;
        pos = m + 2;
        line += 1;
        return { value: parts.join(''), ended: BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: rLine, row: rRow });
      if (parts === null) parts = [text.slice(partStart, m)];
      else parts.push(text.slice(partStart, m));
      added += m - partStart;
      pos = m + 1;
      partStart = pos;
    }
  }

  // Reads a quoted field whose opening quote is at pos, scanning it
  // character by character: a doubled quote is one quote in the value,
  // each CRLF or lone CR inside it is one LF in the value and one line.
  // `rLine`/`rRow` are the current record's line and row, for its errors.
  function readQuoted(rLine, rRow) {
    const open = pos;
    const openLine = line;
    let parts = null; // pieces of the value, null while it is one slice
    let pieceStart = pos + 1;
    let i = pos + 1;
    for (;;) {
      if (i >= len) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: rLine, row: rRow });
        return readUnquoted(['"'], rLine, rRow);
      }
      const c = text.charCodeAt(i);
      if (c === 34) {
        if (i + 1 < len && text.charCodeAt(i + 1) === 34) {
          // A doubled quote: one quote in the value, and the field goes on.
          if (parts === null) parts = [text.slice(pieceStart, i)];
          else parts.push(text.slice(pieceStart, i));
          parts.push('"');
          i += 2;
          pieceStart = i;
          continue;
        }
        // The closing quote at i.
        let value;
        if (parts === null) value = text.slice(pieceStart, i);
        else {
          parts.push(text.slice(pieceStart, i));
          value = parts.join('');
        }
        pos = i + 1;
        if (pos >= len) return { value, ended: END, added: 0 };
        const d = text.charCodeAt(pos);
        if (d === 44) {
          pos += 1;
          return { value, ended: COMMA, added: 0 };
        }
        if (d === 10) {
          pos += 1;
          line += 1;
          return { value, ended: BREAK, added: 0 };
        }
        if (d === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return { value, ended: BREAK, added: 0 };
        }
        // What follows the closing quote is appended as it stands, up to
        // the next comma or line break.
        const junk = readUnquoted([value], rLine, rRow);
        if (junk.added > 0) errors.push({ code: 'quote_junk', line: rLine, row: rRow });
        return junk;
      }
      if (c === 10) {
        if (parts === null) parts = [text.slice(pieceStart, i)];
        else parts.push(text.slice(pieceStart, i));
        parts.push('\n');
        line += 1;
        i += 1;
        pieceStart = i;
        continue;
      }
      if (c === 13) {
        if (parts === null) parts = [text.slice(pieceStart, i)];
        else parts.push(text.slice(pieceStart, i));
        parts.push('\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        pieceStart = i;
        continue;
      }
      i += 1;
    }
  }

  // Reads one record from pos, field by field (the slow path). Returns
  // its fields and whether its first field opened with a quote.
  function readSlowRecord(rLine, rRow) {
    const fields = [];
    let firstQuoted = false;
    let first = true;
    for (;;) {
      let field;
      if (text.charCodeAt(pos) === 34) {
        if (first) firstQuoted = true;
        field = readQuoted(rLine, rRow);
      } else {
        field = readUnquoted(null, rLine, rRow);
      }
      first = false;
      fields.push(field.value);
      if (field.ended !== COMMA) break;
    }
    return { fields, firstQuoted };
  }

  // The fast path for one line, text[a..b): splits it on commas. The
  // line holds no quote at a field start, so no field in it opened with
  // a quote. Returns null when the line needs the slow path: a CR inside
  // it that is not its CRLF ending, or a lone CR with no line break
  // after it. `hasBreak` says the line ends at a line break.
  function readFastLine(a, b, hasBreak) {
    const rPos = text.indexOf('\r', a);
    if (rPos === -1 || rPos >= b) return text.slice(a, b).split(',');
    if (rPos === b - 1 && hasBreak && b - 1 > a) {
      return text.slice(a, b - 1).split(',');
    }
    return null;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? len : nl;
    const hasBreak = nl !== -1;
    let fields = null;
    let firstQuoted = false;

    const qPos = text.indexOf('"', pos);
    if (qPos === -1 || qPos >= segEnd) {
      // No quote on this line at all: the fast path reads it.
      fields = readFastLine(pos, segEnd, hasBreak);
      if (fields !== null) {
        pos = segEnd + (hasBreak ? 1 : 0);
        if (hasBreak) line += 1;
      }
    } else {
      // A quote is on this line: the fast path still reads it when no
      // quote sits at a field start (a quote inside an unquoted field
      // is a literal character). Otherwise the slow path reads the
      // record, field by field.
      let slow = false;
      let q = qPos;
      while (q !== -1 && q < segEnd) {
        if (q === pos || text.charCodeAt(q - 1) === 44) {
          slow = true;
          break;
        }
        q = text.indexOf('"', q + 1);
      }
      if (!slow) {
        fields = readFastLine(pos, segEnd, hasBreak);
        if (fields !== null) {
          pos = segEnd + (hasBreak ? 1 : 0);
          if (hasBreak) line += 1;
        }
      }
    }

    if (fields === null) {
      const record = readSlowRecord(recordLine, recordRow);
      fields = record.fields;
      firstQuoted = record.firstQuoted;
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !firstQuoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
